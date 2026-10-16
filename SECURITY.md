# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- **Secrets**: none. The Sony Audio Control API has no authentication, and the
  configuration holds no password, key nor token. An address typed with
  credentials (`http://user:pass@…`) is refused, so they never reach the logs
  nor the device params.
- **`/data`**: `songpal-state.json` holds, for each device found or typed, what
  it told about itself: its address on the local network, MAC addresses, serial
  number, firmware version, model, its API description and the lists of its
  sources and sound settings. Nothing else.
- **Network**: plain HTTP and WebSocket to the devices on the local network
  (port 10000 by default), and HTTP to the UPnP description of a device found by
  the search, only on the very address that answered the search. The search
  itself (SSDP) is sent by the Gladys core (`network_discovery`). No cloud
  service, no other destination.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and the devices themselves: the Audio Control API is a plain HTTP protocol of
Sony, open to anyone on the local network.
