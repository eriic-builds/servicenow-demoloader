SN DemoLoader for Microsoft Scout

A local Windows skill for reviewed ServiceNow PDI people, incident and Knowledge
content setup aligned with a Microsoft demo tenant. Not for production use.

USERS - START HERE
Open PREREQUISITES.html locally: exact click-by-click PDI/account/role setup,
a per-person Users-table link, cropped private-detail-free reference pictures,
eight-item checklist and troubleshooting. Its design matches the Config Builder. README.md
is the GitHub front door. The guide stores no passwords or progress.
Before installing, prepare an awake owned non-production PDI and create
demo.seeder: Active ON, Machine, Web service access only ON, no lockout/reset,
strong private password, roles admin / itil_admin / knowledge_admin / user_admin.
These are powerful sandbox permissions, not a production/least-privilege model.
Extract the installer ZIP from a trusted publisher. Install.cmd shows
the preparation list; GUIDE opens the instructions, READY acknowledges them,
then TRUST approves the local install. Neither checklist nor acknowledgement
verifies remote access or creates source accounts. Read INSTALL.txt for more
setup, safe update/removal and recovery details.
The unsigned preview supports RemoteSigned through explicit scoped consent; it
does not bypass organization controls or provide an enterprise signing guarantee.
An awake owned PDI and a pre-created API-enabled Machine account with the reviewed
provisioning roles are prerequisites. Installing does not create source records.

DEVELOPERS
Windows, PowerShell 7.2+, Node.js 22+ and Microsoft Edge are required.
There is no npm restore step or third-party runtime dependency.

Build the installer from this repository in any local folder:
pwsh -NoProfile -File .\scripts\build-release.ps1 -Destination 'C:\path\to\releases'
Run the existing regression suite (two test-file workers to avoid saturating
Windows browser/helper processes; all instance traffic uses local fixtures):
pwsh -NoProfile -File .\tests\run-tests.ps1 -Phase all
Build an allowlisted source archive:
pwsh -NoProfile -File .\scripts\build-source.ps1 -Destination 'C:\path\to\releases'

The repository-local skill\ directory is the portable build input. In the
original author's development tree only, the builder can instead read the
separate canonical _Skills\sn-demoloader directory. It never needs that personal
folder layout after a source export. A development launcher intentionally uses
its sibling development output; installed output is always a separate library.

LAYOUT
lib\             Runtime and deterministic provisioning controllers
scripts\         Local CLI, protected helpers, installer and packaging
schemas\         Developer references for config/operation shapes (source only)
packs\           Canned chat-only HR content (no HTML form coupling)
tests\           Built-in Node regression cases and Windows integration fixtures
skill\           Skill instructions and portable front door
package-files.json  Explicit runtime/source export allowlists
release.json     Version and supported runtime minimums
INSTALL.txt      Operating and troubleshooting guide

DATA BOUNDARIES
Skill resources can be replaced during update. Persistent configs/runs are
outside them under %USERPROFILE%\.copilot\SN-DemoLoader-Output-Scout for new installs. Upgrades keep their receipt's output path. Credentials,
approval journals and execution leases stay under LOCALAPPDATA, not in Git.
No live configs, operational outputs, raw screenshots, private session notes,
auth caches or borrowed artwork are part of the source/release exports.
The small release illustration is original. Vendor names/marks identify the
integrations and do not imply endorsement or a grant of trademark rights.
No source-code license has been selected; publication alone does not grant one.

RENAMED FROM SN-DEMOSEEDER
Use /sn-demoloader and the SN-DemoLoader-Scout installer. A receipt-owned legacy
installation upgrades to one new skill registration, keeping output and history.
Unmanaged/authored or duplicate registrations require explicit resolution.
Protected storage, product/receipt identity and source ownership markers retain
legacy identifiers for recovery compatibility; never manually rename them.
The installed Scout command is /sn-demoloader; the GitHub repository is
https://github.com/eriic-builds/servicenow-demoloader.

READINESS
Local regression cases cover trusted download consent/cancellation, tamper
refusal, three Edge locations, exact process ownership, reused-PID handling,
interrupted-install recovery, data-preserving update/removal and fail-closed
source operations. These are not a claim that every corporate policy or PDI
variant is supported. A real separate-user/PDI acceptance remains required
before broad rollout. See INSTALL.txt for the exact first-user acceptance flow.
