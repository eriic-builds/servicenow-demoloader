# SN DemoLoader for Microsoft Scout

Create reviewed people, incidents and Knowledge content in **your own ServiceNow Personal Developer Instance (PDI)**, aligned with your Microsoft demo tenant. Windows only. Not for production use.

**[Open the illustrated setup guide](https://eriic-builds.github.io/servicenow-demoloader/)** | **[Download the Windows installer](https://github.com/eriic-builds/servicenow-demoloader/releases/latest/download/SN-DemoLoader-Scout.zip)**

## Start here: do this before installing

**Open [PREREQUISITES.html](PREREQUISITES.html) locally in your browser.** It is an offline, click-by-click guide with exact field values, a four-role walkthrough, an eight-item checklist and troubleshooting. No coding knowledge is assumed. On GitHub, download/clone the file first; GitHub's source view is not the interactive guide.

Have these ready:

| Requirement | What you need |
| --- | --- |
| Your computer | Windows, Microsoft Scout, PowerShell **7.2+**, Node.js **22+** on PATH, Microsoft Edge |
| Your ServiceNow PDI | An **awake, owned, non-production** instance and a working **Human administrator** login to set it up |
| Scout's Machine account | A separately created **`demo.seeder`** account; Active on, Identity type **Machine**, **Web service access only** on, Locked out off, Password needs reset off |
| Its saved roles | **`admin`**, **`itil_admin`**, **`knowledge_admin`**, **`user_admin`** |
| Its password | A strong, unique Machine password stored privately; enter it only in Scout's masked **Machine account password** field, never in chat or Git |
| Your Microsoft demo tenant | Its `onmicrosoft.com` domain or GUID and the intended people's exact emails; no Microsoft password or directory sign-in is needed for manual setup |

**Shortcut to Users:** in [PREREQUISITES.html](PREREQUISITES.html#account), paste your PDI address and click **Open Users table**. It builds your own `https://<your-PDI>/sys_user_list.do` link. Check for the exact `demo.seeder` first; if it is absent, click **New**. The short, picture-led guide shows **New**, the saved Machine fields, **Roles → Edit...**, and the **right arrow → Save**. Private browser/instance details and user rows are removed. Your entered address is not stored or sent by the guide; only clicking the link opens ServiceNow.

**Create the Machine account yourself first.** The installer does not create it, set its password, grant roles, contact ServiceNow or prove its access. Use your Human admin to create it; do not try to log into the website as the web-service-only Machine.

The four-role recipe reproduces the supported sandbox setup. These are powerful permissions, **not a production or least-privilege model**; `admin` may already include permissions from other roles. Keep inherited roles, do not duplicate them, and do not add `security_admin`, substitute roles or weaken ACLs. The current provisioning path explicitly verifies its installed `admin` role; individual operations check the identities/schema/roles/access they need. The installer's acknowledgement is not proof that all four source assignments were verified.

## Install: no developer tools needed

1. Download **[SN-DemoLoader-Scout.zip](https://github.com/eriic-builds/servicenow-demoloader/releases/latest/download/SN-DemoLoader-Scout.zip)**. The source archives GitHub lists are for developers, not installation.
2. In File Explorer, right-click the ZIP, choose **Extract All...**, then **Extract**.
3. Open the extracted version folder. Start with **`PREREQUISITES.html`** and **`Install.cmd`**. Leave the other files in place; the installer uses them.
4. Double-click **`Install.cmd`**. Do not run it inside the ZIP or choose Run as administrator.
5. Read the prerequisite reminder. Type **`GUIDE`** to open the illustrated steps, or **`READY`** once your PDI, account, password and roles are prepared. Enter without READY cancels.
6. Read the trust message. Type **`TRUST`** only if you trust the release source and requested local action. Otherwise cancel.
7. Wait for **`ok: true`**, then restart Scout so it discovers the skill.
8. Type **`/sn-demoloader`** in Scout and choose **Configure or select environment**.

The installer checks the extracted files automatically; those checks do not authenticate the publisher. This unsigned preview handles Windows RemoteSigned download marks through explicit, scoped consent without changing execution policy. If your device requires signed scripts or enforces AllSigned, AppLocker, WDAC or constrained-language controls, use an **IT-approved signed distribution**. Do not bypass organization controls.

## Connect: use the account you just created

1. In **Environment**, enter a friendly **Config name**, your base **PDI URL** and your **CDX tenant or demo email**.
2. Choose **Use existing account** for the Machine account setup.
3. Choose **Existing Machine account (recommended)** for **Provisioning identity**.
4. Check **Machine user ID** is exactly **`demo.seeder`** (period, not underscore). Keep the Human **Admin user ID** separate.
5. Read the environment authorization statement. Confirm only for your authorized practice environments. Click **Save config**, then **Use this config**.
6. Open **Access**. In the **ServiceNow Machine account** card, enter its own password and click that card's **Save password**.
7. Click **Test read access** and inspect the result. A saved password or successful install is not a connection test. Stop on 401, 403, interactive/login-required or unknown results; use the guide's troubleshooting rather than adding roles or disabling authentication controls.
8. Open **People** and enter the people you intend to use with exact matching Microsoft/ServiceNow emails and deliberate roles. Saving a person is only a local plan.
9. Return to chat. Request the work you need and review its **exact source changes before approving**.

For **Load HR knowledge pack**, the chat item uses one configured, existing Knowledge author/manager to own/author a Human Resources base, Time Off and Leave category and two Published articles, with scoped read/contribute criteria. It is separate from the HTML config. If several people are eligible, choose one in chat. Installing never runs this pack or any other source changes automatically. End-user/connector retrieval needs separate acceptance.

## Where files go

| Purpose | Location |
| --- | --- |
| Installed skill | `%USERPROFILE%\.scout\m-skills\sn-demoloader` |
| Replaceable resources | `<skill>\app` |
| Persistent configs and runs (new installations) | `%USERPROFILE%\.copilot\SN-DemoLoader-Output-Scout` |
| Protected credentials, approvals and execution authority | `%LOCALAPPDATA%\Scout\ServiceNowDemoSeeder` |

An existing Scout store junction is respected. No duplicate is installed under `.copilot\skills`. Existing unmanaged/authored skills are not overwritten. Never upload configs, credentials, auth caches, operational run history or screenshots of your own account to GitHub. The distributed guide uses cropped reference pictures with private instance/browser details removed.

**Renamed from SN-DemoSeeder:** stop its existing Config Builder before upgrading. The new installer replaces only a verified receipt-owned legacy skill with `sn-demoloader`, keeping its recorded output location, credentials and history. If both names exist, or the legacy skill is unmanaged/authored, it stops for explicit resolution rather than overwriting either. Reinstalling also keeps a detected legacy default library; if both old and new libraries exist without a receipt, select the exact `-OutputRoot` explicitly. No accounts or source records are renamed. Protected storage, internal product IDs, installation receipts and source ownership markers intentionally keep their legacy identifiers so existing approvals, recovery and duplicate prevention remain valid. Do not manually move or rename those folders/markers.

## Help, updates and removal

- Reopen the guide: double-click **PREREQUISITES.html**, or run **`Install.cmd Prerequisites`**.
- Read full operational/recovery instructions: **[INSTALL.txt](INSTALL.txt)** in the source repository.
- Update: stop the owned idle Config Builder through the skill, then use the newer verified ZIP's **Install.cmd**.
- Inspect installation: **`Install.cmd Verify`**.
- Diagnose interrupted local state: **`Install.cmd Diagnose`**; only after inspection use **`Install.cmd Recover`**. Never delete PDI execution locks or source journals.
- Remove only the managed skill: **`Install.cmd Uninstall`**. Your output, protected credentials/history and all ServiceNow records remain.

## For people who want to clone or fork

This repository is the **standalone, allowlisted source**, not a copy of the author's full working folder. Git is needed only for clone/fork workflows, not for ZIP installation. Open PREREQUISITES.html first; the PDI/Machine requirements still apply.

From PowerShell 7 in the cloned folder:

```powershell
# Build a release ZIP into a separate absolute destination.
.\scripts\build-release.ps1 -Destination 'C:\path\to\releases'

# Run existing tests. No npm install is needed.
.\tests\run-tests.ps1 -Phase all

# Build an allowlisted standalone source archive.
.\scripts\build-source.ps1 -Destination 'C:\path\to\releases'
```

Open the resulting installer ZIP, Extract All, and follow the regular install flow. The repository-local `skill\` directory supplies the skill instructions and launcher. Local fixtures cover clone/build/install/recovery while mocking source traffic; they do not prove another person's Windows policy, PDI schema or source access.

For GitHub Releases, build with `-ReleaseAsset` and attach only `SN-DemoLoader-Scout.zip`. Its extracted folder still has the version in its name. GitHub generates source snapshots automatically; do not attach a second source ZIP.

The installed guide can be opened through the skill's **Prerequisites** action. Advanced, already-trusted direct installs require **`-Confirm -PrerequisitesConfirmed`**; the second switch explicitly records acknowledgement, not remote verification. Download-marked payloads also require the documented explicit trust flow. Do not use switches to skip preparation or bypass signing policy.

## Release boundaries

This is a **controlled peer-pilot preview**, not a production ServiceNow administration tool. Existing-article revisions/checkout, general content edits, bulk re-seeding/cleanup and connector deployment remain unfinished. Before broad rollout, a real colleague must complete install, configure, approved incident and Published article creation, reopen/update and the HR chosen-person access walkthrough on their own supported PC/PDI.

A source-code license has not yet been selected; publishing alone does not grant one. Vendor names identify integrations and do not imply endorsement or trademark rights.
