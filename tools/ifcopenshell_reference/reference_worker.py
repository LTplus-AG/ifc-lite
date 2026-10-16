"""Private owned-process logger/conversion worker; use ReferenceSession (#7723)."""
import json
import os
from pathlib import Path
import sys


def main():
    output = Path(sys.argv[1])
    # Preserve a protocol channel before redirecting native fd1 (std::cout).
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
    model = settings = None
    for line in sys.stdin:
        request = json.loads(line)
        sequence = request["sequence"]
        with (output / f"{sequence}-engine.log").open("wb") as log:
            sys.stdout.flush()
            os.dup2(log.fileno(), 1)
            os.dup2(log.fileno(), 2)
            response = {"sequence": sequence}
            try:
                if "fixture" in request:
                    import ifcopenshell
                    import ifcopenshell.geom
                    wrapper = ifcopenshell.ifcopenshell_wrapper
                    wrapper.set_log_format_json()
                    wrapper.turn_on_detailed_logging()
                    settings = ifcopenshell.geom.settings()
                    for key, value in request["settings"].items():
                        settings.set(key, value)
                    model = ifcopenshell.open(request["fixture"])
                    products = [{"id": p.id(), "type": p.is_a()} for p in model.by_type("IfcProduct")
                                if getattr(p, "Representation", None)]
                    (output / "products.json").write_text(json.dumps(products))
                    response.update(status="ready", engine=ifcopenshell.version)
                else:
                    # Keep the owner alive until all geometry children are copied (#1124).
                    shape = ifcopenshell.geom.create_shape(settings, model.by_id(request["id"]))
                    geometry = shape.geometry if hasattr(shape, "geometry") else shape
                    data = {"positions": list(geometry.verts), "indices": list(geometry.faces)}
                    (output / f"{sequence}-mesh.json").write_text(json.dumps(data, allow_nan=False))
                    response["status"] = "ok"
            except Exception as error:  # Failure is retained, never returned as a valid mesh.
                response.update(status="error", errorType=type(error).__name__, error=str(error))
            # Release children and their owner before draining conversion logs.
            geometry = shape = None
            # Both buffers matter: the detailed logger usually leaves get_log empty.
            if "ifcopenshell" in locals():
                remaining = ifcopenshell.ifcopenshell_wrapper.get_log()
                if remaining:
                    print(remaining, flush=True)
            sys.stdout.flush()
        protocol.write(json.dumps(response) + "\n")
    protocol.close()


if __name__ == "__main__":
    main()
