# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# #6975: closed loopback connections can time out on mirrored-network hosts.
# Positive native bind proof replaces inferred absence from connection refusal.
function Get-IfcUnusedLoopbackPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.ExclusiveAddressUse = $true
  try {
    $listener.Start()
    $endpoint = [Net.IPEndPoint]$listener.LocalEndpoint
    $receipt = @{port=$endpoint.Port;address=$endpoint.Address.ToString();exclusive=$listener.ExclusiveAddressUse}
  } finally { $listener.Stop() }
  $receipt.stopped = $true
  return $receipt
}
