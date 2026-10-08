/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
using System;
using System.Collections.Concurrent;
using System.Threading;

// Console TextReader.ReadLineAsync may block synchronously. A background reader
// gives the owned Job supervisor a real deadline while preserving EOF/errors.
public sealed class IfcJobInput {
  readonly BlockingCollection<string> lines = new BlockingCollection<string>();
  volatile bool ended;
  volatile Exception error;
  public bool Ended { get { return ended && lines.Count == 0; } }
  public Exception Error { get { return error; } }
  public IfcJobInput() {
    Thread reader = new Thread(() => {
      try {
        string line;
        while ((line = Console.ReadLine()) != null) lines.Add(line);
      } catch (Exception failure) { error = failure; }
      finally { ended = true; }
    });
    reader.IsBackground = true;
    reader.Start();
  }
  public string Read(int deadlineMs) {
    if (deadlineMs <= 0) throw new ArgumentException("Missing input polling deadline");
    string line;
    return lines.TryTake(out line, deadlineMs) ? line : null;
  }
}
