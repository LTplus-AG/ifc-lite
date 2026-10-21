// SPDX-License-Identifier: MPL-2.0
// fault fixture: an unresponsive kernel worker must be terminable by host.
self.onmessage = () => { for (;;) { /* host deadline must terminate this worker */ } };
