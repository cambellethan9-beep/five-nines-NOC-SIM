# Five Nines: project context for Claude

Five Nines is a browser-based **NOC (Network Operations Center) simulator** game. The player keeps an
organization's network up: real-time tickets, SLAs, a Cisco IOS-syntax console, SSH, monitoring, syslog, chat with
staff, desk visits, docs and a notebook. Long-term: ranks, budgets into the billions, hired techs, specializations,
multi-site networks, cloud vs on-prem, seasons, then accounts and a $3/month subscription.

**Read `ROADMAP.md` first.** It is the source of truth for scope, phase order and every agreed decision.
Phases 0 and 1 are done. Phase 2's CCNA core configuration list (items 1-9: filters, ACLs, NAT, IOS DHCP/DNS,
syslog/NTP/SNMP, dynamic routing, switching, operations, security incl. DHCP snooping/DAI/NSOS upgrades) real-time breakage, the skill radar, employees learning from your docs (stale docs), employee topic skills and chat,
and 6 more generator blocks are done. **Next:** finish what's left of Phase 2 in ROADMAP.md, then **Phase 2.5: Python
automation** (its own phase, owner's call); propose before building. Riverside (multi-site) stays locked
until a rank above NOC Manager.

## The owner and how to work with them
- Solo developer with a CCNA. Wants it **realistic and hard**; "harder and more realistic is better."
- Design philosophy: build NOC instinct, **no hand-holding**, Google is encouraged, Cisco IOS syntax must be accurate
  so skills transfer. NetSmart is the fictional vendor ("the only networking vendor ever!"); never use Cisco branding.
- They often reply with numbered yays/nays to proposals. Propose before building anything big (they asked to approve
  the SLA scoring algorithm first, for example).
- Keep everything **browser-only**; no backend or accounts until Phase 7.
- Commit and push to `main` of this repo as work completes (they asked for the repo to be the backup).

## Agreed rules already built (don't change without asking)
- **Tickets:** pre-prioritized by the service desk (right ~75% of the time); a hidden **true priority** from real impact
  drives the SLA clock. Player priority is stored separately (hired techs will act on it later).
- **SLA targets** (game minutes): P1 2/15, P2 5/30, P3 10/60, P4 20/120 (respond/resolve).
- **Points by difficulty:** trivial 40, easy 80, moderate 140, hard 220, expert 300; speed ×1.25 instant → ×1.0 at
  deadline → ×0 at double; breach −50% base; missed response −10%; triage ±.
- **False resolve by rank:** Tier 1 = 0 points and a senior fixes it in 10 min (fix first for half credit); higher ranks
  lose 1% / 2% / 3% of lifetime points; resolving later recovers half.
- **Ranks:** Tier 1 → Tier 2 → Network Engineer (NOC Tier 3) → NOC Supervisor → NOC Manager. Promotion = shift
  score ≥ 500/1,000/2,000/5,000 for 5/10/20/20 shifts in a row (one miss resets the count to 0). Uptime targets 1-5 nines.
- **Points are the core; uptime is informational.** Reliability streak: each shift in a row at or above the rank's
  points bar pays 50 × streak (max 10) × (1 + 0.1 × nines of the uptime target); counts toward promotion; a shift under
  the bar resets it to 0. Shift bonus/penalty depends on tickets in SLA only (downtime still drains points live).
- **Menial work:** at NOC Supervisor / Manager, resolving a trivial or easy ticket yourself earns 0 and costs
  10% / 20% of base (net negative);
  Jordan and Owen can be assigned tickets at those ranks (delegation, full base points, no penalty).
- **Tickets in play at once:** 1 / 2 / 3 / 4 / unlimited by rank; 1.5-4 min breather.
- **Healthy-network income:** +1 point every 2 game seconds while nothing is broken and no incident is open.
- **Downtime drain:** 2 points per affected user per service per minute (10/min for someone with nothing working). Kept as is.
- **Speed:** 1×-100× slider (log scale). **Hardware breakage** (`breakage.ts`): own clock, 0.005 failures per link per shift;
  70% desk cable, 20% infra cable, 7% NIC, 3% switch port; MTBF/MTTR in Monitor and the shift report. Hardware fault
  atoms (`hardware: true`) are never picked by the ticket generator.
- Changing consoles (walking) costs 30 s of game time; SSH from NOC-PC is free. Inherited devices trust the NOC-PC key
  (`ssh nocadmin@<ip>`, no password); default username `nocadmin`.
- **Topics and skills** (`topics.ts`, `team.ts`, `docfacts.ts`): every fault block and template needs topic tags (a test
  checks). Employees: topic skills from certs, learning by doing +2% (one topic) / +3% each (two) / +4% each (three+),
  work without runbooks by skill, read your docs (accurate = bonus, stale = they're misled). Chat with them via `emp:<id>`.
  Generator stays neutral on topics; instead a **growth bonus** (up to +50% base, 0 at radar 70+) for fixing a weak topic.
- Chat is rule-based today (a disclaimer says so). **Approved: AI characters with memory (Phase 2.6, after Python)** via the
  artifact `sample` capability; rule-based chat stays as the fallback.
- Recurring incidents are realistic: most tickets should come from a few common problems.
- **Notify the user:** a fixed incident's reporter stays idle (drains like downtime) until you tell them (DM or announce).
- **Team:** runbooks are notebook notes (marked lines `» `, placeholders, trigger lines of OR/AND phrases; any line
  true = match). The intern (from Tier 2) works matching tickets in the order of the player's priority, resolves only if
  the network check passes (else hands back with a log), keeps their own shift score; 200+ for 5 shifts in a row =
  Tier 1 NOC + 1,000 points; 15-shift term. Training is real time into NetSmart certs (NSCT/NSCA/NSCS/NSCP).
- **Generator:** 60% of new incidents are generated from fault building blocks; every block needs a test that it breaks
  real services, fails the check and passes after `fix()` (tests/generator.test.ts loops over all of them).
- **Escalation** (`src/game/coworkers.ts`): Jordan (Tier 1 peer, 50% credit), Owen (Tier 2, 35%), Gloria (NOC Manager, rank index 4,
  25%, penalty for routine tickets). Upward-only by rank. Coworkers really fix it and explain via `draft.explain`;
  Owen gives one `draft.hint` per ticket in chat. Every ticket template needs `explain` and `hint`.

## Open questions (see the end of ROADMAP.md)
Release timing.

## Code layout
| Path | What |
|---|---|
| `src/sim/` | Engine, no UI: devices, L1/L2/L3 state (`network.ts`), routing/ping (`routing.ts`), IOS output (`render.ts`), SSH (`remote.ts`), PC prompt (`host.ts`), DHCP + APIPA (`dhcp.ts`), DNS resolver/cache (`dns.ts`), traffic, background noise |
| `src/sim/control/` | Routing protocols: OSPF, EIGRP, RIP, BGP, redistribution; cached per `net.version`, adjacency logs |
| `src/sim/` (more) | ACLs (`acl.ts`), NAT (`nat.ts`), IOS DHCP server (`iosDhcp.ts`), syslog/NTP/SNMP (`mgmt.ts`), L2/STP/EtherChannel/VTP (`l2.ts`), MAC table (`mactable.ts`), type 7/login block-for/exec-timeout (`hardening.ts`), flash/TFTP/archive/configure replace (`backup.ts`), snooping/DAI/IPSG/PACL/VACL (`security.ts`), NSOS images/boot/ROMMON (`images.ts`) |
| `src/sim/cli/` | Parser (`parser.ts`), session and modes (`session.ts`), feature command files (`*Commands.ts`, `routingShows.ts`), pipe filters |
| `src/content/` | Cedar Ridge Accounting office (`office.ts`), predecessor docs (`docs.ts`), Phase 0 demo network (tests only) |
| `src/game/` | Game state (`game.ts`), team and training (`team.ts`), runbooks (`runbooks.ts`), who can log in (`access.ts`), fault generator (`faults.ts` building blocks + `generator.ts`), declared incidents (`incidents.ts`), achievements, placement shift, physical layer (`physical.ts`), ticket queue, ticket templates (`templates.ts` + `tickets*.ts` packs, helpers in `ticketKit.ts`), scoring, services/drain, chat, desk actions, browser save (`storage.ts`) |
| `src/ui/` | React views: Tickets (+ search, NOC incidents), Chat, Map, Monitor, Logs, Docs (+ notebook), desk view, front panels, terminal, intro, placement, achievements, settings (colors, hotkeys), Team view, runbook editor (`Runbook.tsx`) |
| `tests/` | Vitest; tests drive the CLI like a player. Keep all tests passing |

Conventions: reachability takes a flow (protocol/port) so ACLs and NAT apply, replies included; routers only listen on their management ports. TypeScript strict; the sim models state, not packets (reachability is computed); fixes are verified by
outcome (`canReach`), not by which commands were typed; new IOS features need realistic output and error messages;
every ticket template needs a test that it breaks something, fails its check, and passes after `fix()`.

## Commands
```bash
npm install
npm test            # vitest, ~300 tests
npm run typecheck
npm run build       # dist/
npm run dev         # local dev server
node scripts/build-artifact.mjs   # bundles dist/ into one HTML file for the share link
```
Open the game with `?debug` to get `window.game`, e.g. `game.queue.startTemplate('trunk-pruned', 0)`.

## Publishing the playable link
The game is shared as a private claude.ai artifact: https://claude.ai/artifact/VvFqpfi5iUCUzuM2D9UKAh
To update it: `npm run build`, then `node scripts/build-artifact.mjs` (writes `artifact/five-nines.html`), then publish
that file with the Artifact tool using `url` = the link above (read it first if the session hasn't).
