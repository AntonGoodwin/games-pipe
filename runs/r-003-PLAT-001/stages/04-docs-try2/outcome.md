# docs: done

The docs check failed on a link I'm not allowed to fix: it is in the task file, outside platform/**. Everything in platform/ is already in order, so I changed nothing.

1. The failing link [[runs/r-003-PLAT-001/report]] is in local-jira/PLAT-001-platform-platform.md, which this stage can't write to. The orchestrator adds that line to the task journal when the run starts. But factory/run.ts writes report.md only when the run ends (writeReport), while the check (brokenWikiLinks in factory/lib/checks.ts) runs during the run. So this link fails the docs check on every run, whatever the docs say: runs r-001 and r-002 have report.md, r-003 does not yet. It needs a fix in factory/: either skip the current run's report in the link check, or write a placeholder report.md when the run starts. Re-running docs won't help until that change is made.

2. My area: I checked with Grep, since running scripts was blocked. Every export in platform/**/*.ts outside tests/ has a /** */ comment directly above it, in wallet, core, sdk/types, testkit and shared. platform/README.md is in place and matches the code: structure, round state, how the result is determined, the interface and how to run the checks. Its wiki links (platform/spec, decisions/platform, local-jira/PLAT-001-platform-platform, docs/conventions) and the ones in spec.md lead to existing files.

I didn't edit the code or the README, so the tsc and test results shouldn't change. The last docs_check passed all 46 of 46 tests.

Assumption (decisions): I did not try to get around the write ban on local-jira/. The broken link is treated as an orchestrator defect and handed to whoever maintains factory/.
