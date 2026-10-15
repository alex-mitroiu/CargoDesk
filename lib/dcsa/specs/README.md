# Vendored DCSA specifications

The published OpenAPI files every DCSA exchange in CargoDesk is validated against (`lib/dcsa/validate.js`).
They are runtime files, not documentation: production refuses to send a payload that doesn't match them.

Source: https://github.com/dcsaorg/Conformance-Gateway, branch `dev`, retrieved 2026-10-11.
DCSA's reference site (https://reference.dcsa.org/content) lists slightly newer patch releases for some
standards (Booking 2.0.5, Bill of Lading 3.0.4, OVS 3.0.3), but those sit behind DCSA member access;
these are the newest public files.

| Key (`validate.js`) | File | Standard | Version | Path in Conformance-Gateway |
|---|---|---|---|---|
| `bkg` | `BKG_v2.0.0.yaml` | Booking | 2.0.4 | `booking/src/main/resources/standards/booking/schemas/` |
| `ebl` | `EBL_v3.0.0.yaml` | Shipping Instructions and Transport Document | 3.0.3 | `ebl/src/main/resources/standards/ebl/schemas/` |
| `eblIssuance` | `EBL_ISS_v3.0.0.yaml` | eBL Issuance | 3.0.3 | `ebl-issuance/src/main/resources/standards/eblissuance/schemas/` |
| `eblSurrender` | `EBL_SUR_v3.0.0.yaml` | eBL Surrender | 3.0.3 | `ebl-surrender/src/main/resources/standards/eblsurrender/schemas/` |
| `pint` | `EBL_PINT_v3.0.0.yaml` | eBL Platform Interoperability | 3.0.0-Beta-20260413 | `pint/src/main/resources/standards/pint/schemas/` |
| `vgm` | `VGM_v1.0.0.yaml` | Verified Gross Mass | 1.0.1 | `vgm/src/main/resources/standards/vgm/schemas/` |
| `tnt` | `TNT_v3.0.0.yaml` | Track & Trace | 3.0.0 | `tnt/src/main/resources/standards/tnt/schemas/` |
| `cs` | `CS_v1.0.0.yaml` | Commercial Schedules | 1.0.3 | `commercial-schedules/src/main/resources/standards/commercialschedules/schemas/` |
| `ovs` | `OVS_v3.0.0.yaml` | Operational Vessel Schedules | 3.0.2 | `ovs/src/main/resources/standards/ovs/schemas/` |
| `an` | `an-v1.0.0-openapi.yaml` | Arrival Notice | 1.0.1 | `arrival-notice/src/main/resources/standards/an/schemas/` |
| `portCall` | `port-call-v2.0.0-openapi.yaml` | Port Call | 2.0.0 | `port-call/src/main/resources/standards/portcall/schemas/` |

File names keep the repository's own (which name the minor line, e.g. `_v2.0.0`); the version that
counts is `info.version` inside each file, shown above and returned by `specVersion(key)`.

To upgrade a standard: replace its file, run `node tests/dcsa-standards.test.js` (it re-extracts the code
lists written in the spec's descriptions and compares them with `lib/dcsa/codes.js`), then the
per-standard lifecycle tests.
