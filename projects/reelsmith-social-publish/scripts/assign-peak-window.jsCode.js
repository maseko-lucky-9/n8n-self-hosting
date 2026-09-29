
const fs = require('fs');
const path = require('path');

const REGIONS = [
  { tz: 'Africa/Johannesburg', hours: [12, 18, 20] },
  { tz: 'America/New_York',    hours: [12, 18, 20] },
  { tz: 'America/Los_Angeles', hours: [12, 18, 20] },
  { tz: 'Europe/London',       hours: [12, 19, 21] }
];
const MIN_LEAD_MIN = 10;
const DEDUP_MIN = 30;

const now = DateTime.utc();
const raw = [];

for (let day = 0; day < 7; day++) {
  for (const r of REGIONS) {
    for (const h of r.hours) {
      const utc = DateTime.now().setZone(r.tz)
        .startOf('day').plus({ days: day, hours: h }).toUTC();
      if (utc.diff(now, 'minutes').minutes >= MIN_LEAD_MIN) {
        raw.push(utc);
      }
    }
  }
}

raw.sort((a, b) => a.toMillis() - b.toMillis());

const windows = [];
for (const w of raw) {
  const last = windows[windows.length - 1];
  if (!last || w.diff(last, 'minutes').minutes >= DEDUP_MIN) {
    windows.push(w);
  }
}

if (windows.length === 0) {
  throw new Error('No peak windows available in 7-day lookahead');
}

// --- Atomic claim store: closes the 8h-rescan double-post race ----------------
// The next Scanner Trigger re-indexes the SAME un-archived manifest while clips
// are mid-Wait (no ledger row yet) -> would re-schedule + double-post. An fs
// O_EXCL marker on the shared hostpath PVC is atomic across both workers
// (verified: a 2nd `wx` write -> EEXIST on the live mount). The marker is keyed
// on `filename` (the same column the results ledger + unpublished-inventory.js
// use), so a re-indexed clip that is in-flight OR already posted hits EEXIST and
// is skipped. No external require() -- `fs`/`path` are the only allowlisted
// builtins (avoids the luxon-style sandbox abort that caused this outage).
//
// ponytail: marker is NEVER released on success -> a clip that exhausts the
//   in-execution upload retries stays claimed. Safe direction (blocks a double
//   post, not a missed retry; the watchdog + unpublished-inventory.js surface
//   drops). Recover a genuinely stuck clip: run unpublished-inventory.js, then
//   `rm <jobDir>/.claims/<filename>.json`. Atomicity assumes single-node local
//   fs; on multi-node/NFS, O_EXCL is not atomic -> move to a Postgres UNIQUE claim.
const execId = (typeof $execution !== 'undefined' && $execution && $execution.id) ? $execution.id : 'na';
const out = [];
for (const item of $input.all()) {
  const filename = item.json.filename;
  const jobDir = item.json.jobDir;
  if (!filename || !jobDir) {
    throw new Error('Claim store: item missing filename/jobDir: ' + JSON.stringify(item.json).slice(0, 200));
  }
  const claimDir = path.join(jobDir, '.claims');
  fs.mkdirSync(claimDir, { recursive: true });
  const marker = path.join(claimDir, path.basename(String(filename)) + '.json');
  try {
    fs.writeFileSync(
      marker,
      JSON.stringify({ claimedAt: now.toISO(), execId, clipIndex: item.json.clipIndex }),
      { flag: 'wx' }   // O_EXCL: throws EEXIST if the clip is already claimed
    );
  } catch (e) {
    if (e && e.code === 'EEXIST') continue;   // already claimed (in-flight or posted) -> skip
    throw e;
  }
  out.push({
    json: {
      ...item.json,
      scheduledAt: windows[item.json.clipIndex % windows.length].toISO()
    }
  });
}

return out;
