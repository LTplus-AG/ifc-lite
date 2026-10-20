// SPDX-License-Identifier: MPL-2.0
// Version 1 framing is documented in README.md. stdout is exclusively protocol.
#include "protocol.h"
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <vector>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#else
#include <unistd.h>
#endif
namespace {
FILE* protocol = nullptr;
constexpr uint32_t max_frame = 4096;
// Read without interpreting an incomplete prefix as a clean end-of-stream.
bool read_frame(std::vector<uint8_t>& bytes) {
    std::array<uint8_t,4> prefix;
    const size_t count = std::fread(prefix.data(),1,4,stdin);
    if (count == 0 && std::feof(stdin)) return false;
    if (count != 4) throw std::runtime_error("truncated frame prefix");
    uint32_t length = 0;
    for (unsigned i = 0; i < 4; ++i) length |= uint32_t(prefix[i]) << (8*i);
    if (length < 12 || length > max_frame) throw std::runtime_error("invalid frame length");
    bytes.resize(length);
    if (std::fread(bytes.data(),1,length,stdin) != length) throw std::runtime_error("truncated frame");
    return true;
}
void write_frame(const std::vector<uint8_t>& body) {
    std::array<uint8_t,4> prefix{};
    for (unsigned i=0;i<4;++i) prefix[i]=uint8_t(body.size() >> (8*i));
    if (std::fwrite(prefix.data(),1,4,protocol) != 4 ||
        std::fwrite(body.data(),1,body.size(),protocol) != body.size() ||
        std::fflush(protocol) != 0) throw std::runtime_error("response write failed");
}

}
int main() {
#ifdef _WIN32
    _setmode(_fileno(stdin),_O_BINARY); _setmode(_fileno(stdout),_O_BINARY);
    const int descriptor = _dup(_fileno(stdout));
    if (descriptor >= 0) protocol = _fdopen(descriptor,"wb");
    const int redirected = _dup2(_fileno(stderr),_fileno(stdout));
#else
    const int descriptor = dup(fileno(stdout));
    if (descriptor >= 0) protocol = fdopen(descriptor,"wb");
    const int redirected = dup2(fileno(stderr),fileno(stdout));
#endif
    if (!protocol || redirected < 0) {
        std::fprintf(stderr,"SMLib worker: cannot isolate protocol output\n"); return 1;
    }
    static_assert(sizeof(double) == 8 && std::numeric_limits<double>::is_iec559,
        "protocol requires IEEE binary64");
    try {
        std::vector<uint8_t> frame;
        while (read_frame(frame)) { write_frame(ifclite_smlib_dispatch(frame)); }
        std::fclose(protocol); return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr,"SMLib worker: %s\n",error.what());
    } catch (...) {
        std::fprintf(stderr,"SMLib worker: unknown exception\n");
    }
    std::fclose(protocol); return 1;
}
