# Five Nines: Roadmap

A browser-based, single-player Network Operations Center simulator. You start as a Tier 1 NOC Technician
replacing an analyst who left, and you keep an enterprise network running against SLAs, vague tickets, audits,
a change board of one, and a terrible VP.

**Pillars**
- **Build NOC instinct, not tutorial-following.** One tiny tutorial, then you're on your own. Googling is encouraged.
- **Practical CCNA / Network+ skills.** Real Cisco IOS syntax on fictional **NetSmart** gear ("the only networking vendor ever!"). Real syslog format.
- **Enterprise realism.** SLAs, MTTR/MTBF, documentation drift, compliance audits, change management, budgets.
- **Offline, single-player gameplay.** Every other character is AI or scripted. The only online parts are login and subscription.

---

## Tech stack (proposed)

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript | One language for the sim and the UI |
| Build | Vite | Fast, outputs static files |
| UI | React | Panels, ticket queue, chat, notebook |
| Map / topology | SVG (React) at first, PixiJS if performance requires it | Clickable, themeable, easy renaming in place |
| Sim engine | Pure TS module with no UI dependencies | Testable, deterministic, runs in a Web Worker |
| Save data | IndexedDB (local) | Offline play |
| Accounts / limits | Supabase (auth + one small table) | Cheap, minimal backend |
| Payments | Stripe Checkout + webhook | $3/mo subscription |
| Hosting | Static host (Cloudflare Pages / Netlify / Vercel) | Close to free |
| Tests | Vitest | Fault library and CLI correctness |

**Key architecture decision: the sim models state, not packets.** The network is a graph of devices, interfaces,
links, VLANs, routing tables and ACLs. Reachability ("can User X reach the file server?") is computed from that state.
This keeps the game fast and deterministic and is accurate enough for CCNA-level troubleshooting. `ping` and
`traceroute` output is produced from the computed path.

---

## Phase 0: Foundations
**Goal:** the engine exists and a router answers commands.

- [x] Project scaffold (Vite + React + TS + Vitest), folder layout (`src/sim`, `src/ui`, `src/content`, `tests`)
- [x] Sim data model: routers, L2/L3 switches, PCs, servers, interfaces, cables, VLAN database (AP and firewall come later)
- [x] Reachability engine: L1 (admin state, cables, speed mismatch), L2 (access/trunk, DTP, native/allowed VLANs, SVIs,
      router-on-a-stick), L3 (connected, static and floating static routes, default gateway, ARP, proxy ARP)
- [x] Sim clock and tick loop (main thread for now; moving to a Web Worker is deferred until profiling shows a need)
- [x] Seeded RNG utility, so every scenario can be replayed (#21)
- [x] **Cisco IOS CLI, core set:** user/privileged/config/interface/subinterface/range/VLAN modes, `enable` (with secret),
      `conf t`, `interface`, `interface range`, `shutdown`/`no shutdown`, `ip address`, `switchport mode/access/trunk`,
      `encapsulation dot1Q`, `speed`/`duplex`, `ip route`, `ip default-gateway`, `hostname`, `banner motd`, `vlan`/`name`,
      `show ip int brief`, `show run`/`start`, `show interfaces [status|trunk]`, `show vlan brief`, `show ip route`,
      `show arp`, `show cdp neighbors [detail]`, `show version`, `show clock`, `ping`, `traceroute`, `write mem`,
      `copy run start`, `erase startup-config`, `reload`, `do`, abbreviations, `?` help, Tab completion, history
- [x] Realistic IOS behavior: caret errors, ambiguous/incomplete commands, hostname lookup on typos, global commands from
      interface mode, console log messages, unsaved changes lost on reload, VLANs stored in vlan.dat
- [x] Test bench page with the tutorial incident (SW1 Fa0/1 shut down) and a basic PC prompt
- [x] **Remote management (SSH/Telnet):**
  - NOC-PC client with OpenSSH syntax: `ssh nocadmin@<ip> -p <port>`, `-l`, default user = logged-in Windows user (`nocadmin`)
  - Host key prompt, known_hosts, and a "REMOTE HOST IDENTIFICATION HAS CHANGED" warning after keys are regenerated
  - Inherited devices trust the NOC PC's key (`ip ssh pubkey-chain`), so login needs no password
  - Factory-default devices need real setup: `hostname`, `ip domain-name`, `crypto key generate rsa`,
    `username nocadmin privilege 15 secret ...`, `line vty`, `login local`, `transport input ssh`
  - Custom SSH port with `ip ssh port P rotary N` + `rotary N` on the vty lines (port 22 keeps working)
  - Telnet with line passwords, `ssh -l`/`telnet` from routers, `terminal monitor`, `show ip ssh`,
    "% No password set" for `enable` over vty, console login, sessions dropped when a device reloads

**Done when:** you can type IOS commands at a NetSmart router in a test page and break or fix reachability. ✅

---

## Phase 1: Vertical slice (one facility, one shift)
**Goal:** the core loop is playable start to finish.

- [x] **Facility topology view (#6):** Cedar Ridge Accounting (20 staff, 4 VLANs, 2 floors + server room), health colors,
      link states, select a device to inspect, rename in place (running config only), walk to its console (+30s)
- [x] **Device monitoring page (#6/#7):** status, uptime, CPU, throughput chart (10 min), per-port status/VLAN/traffic
- [x] **Real-time ticket queue (#1, #9):** own tab; tickets arrive live, pre-prioritized by the service desk
      (sometimes wrong) with a hidden true priority from real impact; acknowledge, re-prioritize, notes, resolve;
      tickets in play at once by rank (Tier 1: 1, Tier 2: 2, Network Engineer: 3, NOC Manager: no limit) with a 1.5-4 min breather after each; 9 ticket types from trivial (shut port) to expert (partners VLAN build)
- [x] **Syslog feed (#8):** real format, severity/device/text filters, noise (PCs sleeping, SNMP auth failures,
      failed logins), SSH login messages, 15 minutes of history before the shift starts
- [x] **User desktop view (#12):** desk visit (+30s walk) with Windows network status, Device Manager (disabled adapter,
      outdated driver Code 10, missing driver Code 28; online driver search fails without internet, toolkit USB works),
      Command Prompt, and behind-the-desk checks (cable seated in NIC, link light, damaged cable, wall jack label)
- [x] **Chat (#10):** own tab; all-staff channel + DMs; personas (helpful, impatient, clueless, ghost); unprompted complaints
      that pile on during outages; status updates calm people down; answers come from the PC's real state; helpful users
      will plug a loose cable back in
- [x] **Notebook (#47):** "Your notebook" section in Docs; add, edit, delete; light formatting; saved with the game
- [x] **Predecessor's documentation (#50):** README, network overview (VLANs, IPs, management IPs, uplinks, ISP),
      desk and port map, and 4 playbooks. Static, so they drift out of date as the network changes
- [x] **SLA + scoring (#40–42, #42a):** P1-P4 response/resolve targets on true priority, difficulty-based points
      (40-300), speed bonus, breach/response/triage adjustments, rank-based false-resolve rules (senior takeover at
      Tier 1, up to 3% of lifetime points at NOC Manager, partial recovery on revisit), caught-early bonus,
      per-user-per-service downtime drain, +1 point every 2s while the network is healthy and no incident is open,
      availability %, end-of-shift report vs rank targets
- [x] **Fix verification by outcome:** a ticket resolves when the symptom is actually gone, whatever commands fixed it
- [x] **Tutorial (#48):** first-day intro (time paused), tour, "Google is your friend" (#51), the shut-port incident with no
      hand-holding, then a one-time debrief that opens a prefilled notebook entry; Help button reopens the tour
- [x] Opening note: NetSmart gear uses Cisco IOS syntax (#54)
- [x] Save/load: autosave to the browser (localStorage) every 15s and when the tab is hidden; New game button
- [x] **Physical console access costs time:** changing consoles costs 30 seconds of game time,
      so SSH from the NOC PC is the fast path once a device is reachable and configured for it

- [x] **Escalation to coworkers:** Jordan Reyes (Tier 1, 6 months ahead; 50% credit, handles simple tickets, may hand
      harder ones back), Owen Price (Tier 2, 2 years; 35% credit, explains fixes, random facts, one hint per ticket in
      chat), Gloria Haines (NOC Manager, 10 years; 25% credit, solves anything, penalty for routine tickets). They really
      fix the network; upward-only escalation by rank (none left at NOC Manager)
- [x] **Rank ladder and promotions:** Tier 1 → Tier 2 → Network Engineer (NOC Tier 3) → NOC Supervisor → NOC Manager.
      Promotion = shift score ≥ 500 / 1,000 / 2,000 / 5,000 for 5 / 10 / 20 / 20 shifts **in a row** (saves in between
      are fine; one shift under the bar resets the count to 0). Uptime targets 1 to 5 nines; ticket limits 1/2/3/4/∞.
      Ranks above Manager will use other prerequisites (facilities managed, etc.)
- [x] **Reliability streak:** each shift in a row that reaches the rank's points bar pays 50 × streak (counts up to 10)
      × the nines multiplier of the rank's uptime target (1 nine ×1.1 … 5 nines ×1.5). Counts toward promotion.
      A shift under the bar resets the streak to 0, the same as the promotion count
- [x] **Points are the core, uptime is informational:** some downtime is unavoidable. Downtime still drains points while
      it lasts, but missing the uptime target adds no extra penalty; the shift bonus/penalty rides on tickets in SLA
- [ ] **Tier 3 unlocks network changes:** from Network Engineer on you can change the topology itself (add, move and
      replace routers and switches), not only configure what's there
- [x] **Editable inherited docs:** Edit any reference doc or playbook in place (tables included), saved with the game,
      with Revert to original. Notes also support tables, numbered steps and callouts
- [x] **Desktop network settings:** IPv4 Properties panel (DHCP or static IP, mask, gateway, DNS) with Windows-style validation
- [x] **Four more tickets:** APIPA after a blip (trivial), wrong static gateway (easy), stale DNS cache (easy),
      `ip helper-address` removed with APIPA spreading as PCs wake (moderate). 18 ticket types total
- [x] **Router-on-a-stick and ISL:** spare CR-CORE1 Fa0/23 to CR-RTR1 Gi0/2 cable (in the docs) makes ROAS possible;
      `encapsulation isl` on router subinterfaces and `switchport trunk encapsulation isl|negotiate` on L3 switches;
      ISL and dot1Q ends don't interoperate

**Done when:** a new player can finish the tutorial and a short shift of handcrafted tickets, and get scored.

---

## Configuration coverage plan
So players never hit a ceiling, IOS features arrive in three waves. Each feature brings its `show` commands, realistic
error messages, the faults it can cause, and ticket templates that use it.

**Wave A: CCNA core (Phase 2, next).** Without these, CCNA-level players run out of things to learn.
- [x] Output filters: `| include`, `| exclude`, `| section`, `| begin`
- [x] `show mac address-table`, `show interfaces counters errors`, duplex mismatch symptoms (CRC, late collisions)
- [x] **ACLs:** standard, extended, named; wildcard masks; `ip access-group in/out`; `access-class` on vty lines; hit counters
- [x] **NAT/PAT:** inside/outside, overload, static NAT for servers (replaces the ISP routing stand-in)
- [x] **DHCP:** IOS DHCP server, pools, exclusions, `ip helper-address`; PCs switch to DHCP clients (169.254.x.x when it fails)
- [x] **DNS:** `ip name-server`, `ip host`, PCs resolve names (ping by name, "websites won't load but 8.8.8.8 works")
- [x] **Syslog:** `logging host`, `logging trap`, `service timestamps`; devices only appear in the Logs tab once configured
- [x] **NTP:** client/server, `show ntp status`, clocks finally leave 1993
- [x] **SNMP:** communities, v2c vs v3; devices only appear in Monitor once configured
- [x] **OSPFv2:** single and multi-area, neighbor states, area/timer/MTU mismatch, passive interfaces, router IDs, cost, DR/BDR
- [x] **STP (PVST+):** root bridge, PortFast, BPDU guard, loops and broadcast storms
- [x] **Port security:** max MACs, sticky, violation modes, err-disabled, `errdisable recovery`
- [x] **EtherChannel:** LACP/PAgP, mismatched members, suspended ports
- [x] **VTP:** modes, domain, the revision-number wipe
- [x] Hardening: `service password-encryption`, `exec-timeout`, `login block-for`, login/exec banners, `security passwords min-length`
- [x] Config backup and restore: `copy run tftp`, `archive`, `configure replace`

**Wave B: multi-site and security (Phase 3-4, as the network grows past one building).**
- [ ] **Site-to-site VPN** (IPsec, GRE over IPsec) and WAN links between facilities
- [ ] **HSRP** first-hop redundancy; dual ISP circuits
- [x] **BGP basics (built early):** eBGP to the ISP, dual-homing, prefix filtering (beyond CCNA, needed at ISP scale)
- [ ] **IPv6:** addressing, SLAAC, static routes, OSPFv3
- [x] **DHCP snooping and dynamic ARP inspection** (rogue DHCP server tickets)
- [ ] **AAA:** local, RADIUS/TACACS+, fallback when the server is down; 802.1X port authentication
- [ ] **Dedicated firewall appliances** (NetSmart firewall line): zones, rule sets, NAT, site-to-site and remote-access VPN,
      high-availability pairs, logging; bought with the budget, sized by throughput
- [ ] Voice VLAN, basic QoS (trust/marking), LLDP
- [ ] Password recovery (config register), IOS upgrades, SFP optics and fiber, PoE budgets, power supplies and fans

**Wave C: specialist depth (Phase 4-5, unlocked by specializations).**
- [ ] **Wireless:** controller and APs, SSID-to-VLAN mapping, WPA2/WPA3, guest Wi-Fi, channels and interference
- [ ] **Cloud networking:** VPCs/subnets, security groups, route tables, VPN or dedicated links to on-prem
- [ ] **Automation:** RESTCONF-style API console and Ansible-like playbooks to push config at scale
- [ ] **Monitoring depth:** NetFlow, alert thresholds and noise tuning
- [ ] **Data center:** spine-leaf, storage traffic, load balancers
- [ ] **Security operations:** IDS alerts, incident response, segmentation projects

---

## Phase 2: Procedural scenarios and Wave A
**Goal:** effectively unlimited, varied incidents, built on the Wave A configuration features.

- [x] **Fault library framework (#21):** each fault = preconditions + injection + symptoms + ticket templates + verification (the generator: src/game/faults.ts + generator.ts)
- [x] **CCNA core configuration, built in this order** (Wave A; each with its `show` commands, IOS errors, faults and tickets):
  1. [x] Output filters: `| include`, `| exclude`, `| section`, `| begin`, `| count` (exec, `do`, over SSH; `?` after the pipe)
  2. [x] ACLs: standard, extended, named (sub-mode, sequence numbers, remarks); wildcard masks (IOS normalizing included);
         `ip access-group in/out`; `access-class` on vty lines; hit counters; `show ip interface`; enforced on real flows
         (HTTPS, SMB, DNS, printing, SSH, DHCP relay, ICMP, traceroute `!A`), replies checked too (`established`).
         Tickets: web filter (hard), printer wildcard (moderate), vty lockout (moderate)
  3. [x] NAT/PAT: inside/outside, overload (PAT with port reuse), pools (one-to-one runs out), static one-to-one and port
         forwards (incl. `interface`), IOS order of operations with ACLs, translation table from real traffic,
         `show ip nat translations|statistics`, `clear ip nat translation *`. The ISP stand-in is gone: CR-RTR1 runs the
         predecessor's PAT. Network gear only listens on its management ports. Tickets: NAT ACL narrowed (moderate),
         overload dropped (hard), `ip nat inside` missing (easy)
  4. [x] DHCP: IOS DHCP server (`ip dhcp pool` with network/default-router/dns-server/domain-name/lease,
         `ip dhcp excluded-address`, `service dhcp`, bindings, conflict detection, show/clear), serving the new GUEST
         VLAN 40 (conference room PC CR-CONF1, internet-only via the GUEST-IN ACL). Tickets: no default-router,
         pool full from infinite leases, guest DNS pointed inside. *Done earlier:* staff PCs are DHCP clients of CR-DC01 (reservations),
         `ip helper-address` relay, APIPA on failure, `ipconfig /release /renew /all`, renew on link-up
  5. [x] DNS: `ip name-server`, `ip host`, `show hosts`, ping/traceroute by name, EXEC typos asking the configured
         server, public DNS at 8.8.8.8 for guests. *Done earlier:* PC resolver with cache, CR-DC01 zone, `nslookup`,
         ping/tracert by name, `ipconfig /displaydns /flushdns`, LedgerWorks resolved by name
  6. [x] Syslog, NTP and SNMP (built): `logging host/trap/buffered/console/monitor`, `service timestamps log datetime|uptime`,
         `show logging`; `ntp server/master`, `show ntp status|associations`, `clock set`, unsynced clocks run from 1993
         with `*`; `snmp-server community [acl]`, location/contact, v3 groups/users, `show snmp`. The Logs tab only shows
         what reaches NOC-PC's syslog server; Monitor graphs need the `cedar-mon` SNMP poll to answer. CR-ACC2 (a
         replacement switch) never got any of it, though the README says otherwise. Originally planned: `logging host`/`trap`, `service timestamps`, NTP client/server, SNMP v2c/v3; devices only
         appear in Logs and Monitor once configured
  7. [x] Dynamic routing (all of it, owner's stipulation), computed by a control plane in `src/sim/control/`:
         - OSPFv2: network statements and `ip ospf <pid> area`, router IDs, passive interfaces, costs and reference
           bandwidth, hello/dead/network-type/auth/mask/stub checks (silent like IOS), area mismatch and duplicate RID
           logs, MTU mismatch stuck in EXSTART (`ip ospf mtu-ignore`), DR/BDR election, intra/inter-area, E1/E2,
           stub and totally stubby areas, default-information originate, ECMP, `show ip ospf [neighbor|interface
           [brief]|database]`
         - EIGRP classic and named mode (address-family, af-interface, topology base): K-values (mismatch logged),
           composite and wide metrics from bandwidth/delay at negotiated speeds, passive, auto-summary, D EX
         - RIP v1/v2: version compatibility, classful networks, auto-summary, passive (still listens), default
         - Redistribution between all of them with IOS gotchas (`subnets`, seed metrics); BGP: eBGP/iBGP sessions,
           network statements needing a RIB match, default-originate, AS-path loop prevention, next-hop-self,
           ebgp-multihop, update-source; `show ip bgp [summary]`
         - `show ip protocols`, `show ip route <proto>|<addr>`, route ages, adjacency syslogs
         - HQ now runs OSPF area 0 between CR-CORE1 and CR-RTR1 (statics retired); Brightline is ready to peer BGP.
           Tickets: passive-interface default, hello mismatch, area mismatch, default not originated, BGP migration
         - Multi-site (Riverside) stays locked by rank; EIGRP/RIP/multi-area designs come into play there
         Originally planned: OSPFv2 single and multi-area, neighbor states, area/timer/MTU mismatch, passive interfaces, router IDs, cost, DR/BDR
  8. [x] Switching (`src/sim/l2.ts`): PVST+/rapid-pvst root election by priority and MAC, speed-based costs, roles
         and states, PortFast (+ default), BPDU guard (err-disable), BPDU filter, root guard (ROOT_Inc), loop guard
         (LOOP_Inc), broadcast storms with MACFLAP logs when a loop forwards; port security (maximum, sticky, static,
         shutdown/restrict/protect, `clear port-security`), err-disable with shut/no shut and `errdisable recovery`;
         EtherChannel on/LACP/PAgP with IOS pairing rules, suspended members, Po config propagation, STP sees one link;
         VTP server/client/transparent/off, domain/password/version, revision wipe. Office: core is root, PortFast and
         BPDU guard on access switches, sticky port security on the 2nd floor, VTP transparent, a spare (shut) second
         uplink core Gi0/3 to CR-ACC1 Gi0/2. Tickets: storm via bpdufilter (expert), desk switch vs BPDU guard,
         loaner PC vs port security, LACP uplink request (hard), VTP wipe (expert)
  9. [x] Operations: duplex negotiation (a hard-coded end stops autonegotiating, the auto end falls back to half at
         10/100) with CRC/runts on the full side, late collisions on the half side, lossy pings and a CDP
         DUPLEX_MISMATCH log between switches; `show interfaces` error counters, `show interfaces counters errors`,
         `clear counters`; `show mac address-table` [dynamic|static|address|interface|vlan|count|aging-time] computed
         from live L2 state (trunks, STP, EtherChannel, sticky = STATIC) and `clear mac address-table dynamic`
         (stations relearn as they talk); hardening: `service password-encryption` (real type 7, `password 7` input),
         `enable password`, `security passwords min-length`, `exec-timeout` (idle consoles and SSH sessions really get
         logged out), `login block-for` quiet mode + `login quiet-mode access-class`, `show login`, `banner login|exec`
         (login banner before SSH auth, motd after); backup/restore: `copy` between running/startup/flash:/tftp: with
         IOS prompts, a TFTP server on the NOC PC, `archive` (path with $h/$t, write-memory, time-period, maximum),
         `archive config`, `show archive`, `show archive config differences`, `configure replace [list] [force]`,
         `dir flash:`. A copy into running-config merges like IOS (it never un-shuts a port); a replace is exact.
         Office: the predecessor left `exec-timeout 0 0` on CR-RTR1/CR-CORE1 and a clear-text `username backup` on the
         router. Tickets: duplex mismatch to a server, rogue device hunt by MAC, config backups request, edge-router
         hardening audit
  10. [x] Security: the rest of the ACL family (time-based with `time-range` periodic/absolute on the device clock,
         reflexive `reflect`/`evaluate`, port ACLs inbound on switchports, VLAN access maps with `vlan filter` and the
         implicit drop, MAC ACLs (non-IP only), `ip access-list resequence`, `show time-range`); DHCP snooping (trust,
         bindings from real leases, option 82 with zero giaddr dropped by an untrusting relay, `ip dhcp relay
         information trusted|trust-all`, rogue DHCP servers silenced on untrusted ports); dynamic ARP inspection
         (bindings, ARP ACLs and `filter ... static`, trust, 15 pps limit err-disabling an untrusted uplink, DENY
         logs); IP source guard and `ip source binding`; NSOS images (versioned files on flash and the NOC TFTP root,
         `copy tftp: flash:` with space checks, `verify /md5`, `delete`, `boot system`, `show boot`, `reload in|at|
         cancel`, `show reload`, boot fallback to the first good image, ROMMON with `dir`/`boot`/xmodem/`tftpdnld`).
         Tickets: unused ports, enable/console passwords, snooping rollout, DAI rollout (expert), NSOS upgrade from
         a vendor advisory (filename, size and MD5 given), guest hours time-range, rogue DHCP server, DAI vs static
         printers, option 82 outage
- [x] **Owner's quick wins (approved Nov 2026):** number-key hotkeys (1-6 views, 7 console, 8 prompt, / search,
      Alt+number while typing); cosmetic color presets and pickers (per browser); ticket search and filters;
      NOC-declared incidents (from Tickets, Logs or Monitor) with status, timeline, auto-linked user reports that
      count as acknowledged, and a post-incident review that can close linked tickets and go to the notebook;
      achievements (lifetime-point titles from "The Okayest Intern Ever" at 1,000 to 1,000,000, plus feats);
      optional placement shift on a new game (an ordinary shift with a Network Engineer's ticket mix and limit of 3
      in play, exactly like a regular shift, escalation and hints included; 600+ = Tier 2, 900+ = Network Engineer; the
      points don't count toward your career; Owen wraps up anything left open; one attempt per game);
      physical layer: switch front panels (LEDs, physical port labels separate from `description`, unplug and
      move patch cables when standing at the switch), printer front panel (cable, network page, firmware update
      with reboot), print drivers on PCs. Tickets: printer cable, broken print driver, cable moved to the wrong port
- [x] **Documentation carries over ("rebirth"):** your notebook and doc edits live outside the game save and come
      with you into every new game; deleting them takes three confirmations in Settings
- [x] **Who can change the network (Nov 2026):** the contractor, the MSP and Tom get in with the shared admin passwords
      (nocadmin's original secret, the router's `backup` account). Change them, or lock the vty lines to the NOC with an
      access-class, and their changes (and the tickets they cause) stop; only Jordan keeps access
- [x] **Escalations are checked:** a coworker's fix is verified against the network; if the ticket's users are still
      down they hand it back honestly, and they mention when others are down for an unrelated reason
- [x] **Custom backgrounds (owner's request, built for the console and the Map canvas):** each has its own image (a web
      link, or a file shrunk to fit browser storage), fit (fill / whole image / tile), dim and blur; the Map's floor
      zones turn see-through. Other areas (page backdrop, sidebar, main view, top bar, dialogs) can follow on request
- [x] **Pause:** button and P key (Alt+P while typing); stops the shift clock, SLAs, drain and real-time training; the
      pause screen blocks play and offers Settings (backgrounds) and Achievements
- [ ] **Python automation lab (Pyodide)**: moved to its own phase right after Phase 2 (Phase 2.5 below)
- [x] **Faults and tickets that use them:** (the last three built Nov 28 2026: native VLAN mismatch as a generator block
      with real PVST+ PVID-inconsistent blocking, `show spanning-tree` BKN*/PVID_Inc, `inconsistentports` and the
      %CDP-4-NATIVE_VLAN_MISMATCH / %SPANTREE-2-*_PVID_* logs; NTP drift as a SecOps request on CR-ACC1 pointed at a
      dead NTP server with a clock ~40-57 min fast; ISP outage upstream of the circuit: our WAN link stays up, their
      router answers, traceroute dies after it. Fix: call Brightline from the ISP router on the Map with the circuit
      ID from the docs; wrong ID = "can't find it", nothing wrong on their side = ~10 min lost on hold; a real fault
      gets a carrier ticket and an ETR of 18-45 min, then service comes back and you resolve and tell everyone)
  - L1/L2: duplex mismatch errors (done), native VLAN mismatch, err-disabled (port security), STP loops, EtherChannel, VTP wipe
  - L3: wrong gateway, wrong IP/mask, missing static route, OSPF neighbor down (area/timers/passive), ACL blocking traffic
  - Services: DHCP scope exhausted / helper missing, DNS wrong, NTP drift, NAT broken after a router swap
  - Endpoint: APIPA address, wrong DNS on a PC
  - Upstream ISP outage (prove it with traceroute, then call the carrier with the circuit ID)
  - Red herrings, cascading failures with one root cause, an undocumented coworker change
- [x] **Hard (220-point) ticket templates** (none exist yet) (many exist now)
- [x] **Generator (approved Nov 2026, `src/game/faults.ts` + `generator.ts`):** 24 fault building blocks (desk, access
      port, trunk, VLAN, SVI, DHCP relay, ACL, server ports, printers, default route) placed where they can really
      happen; ticket text, subject and true priority come from the real impact on real users, in the reporter's
      persona; extra related faults by rank (Tier 2 sometimes, Tier 3+ often, up to 3), red herrings from Tier 3,
      "Configured from console by <coworker>" logs on config faults; difficulty from the faults; checked by outcome
      (every hurt user has their services back); 60% generated / 40% hand-built. Nov 28 2026: +6 blocks (OSPF
      passive-interface on the uplink, OSPF network statement missing VLAN 10, `ip nat inside` gone, NAT ACL narrowed
      to the servers, helper-address pointing at the wrong server, port-security violation from a new dock)
- [x] **Tell the user it's fixed:** a resolved incident leaves its reporter idle (draining like an outage) until you
      notify them directly or announce to everyone; they chase you in chat; coworkers notify on their own fixes
- [x] **Real-time breakage (#2):** hardware wears out on its own clock (`src/game/breakage.ts`), separate from the
      ticket generator and ignoring the rank's ticket limit (hardware doesn't wait). Realistic and average: random
      (Poisson) failures at 0.005 per cabled link per shift, so the ~30-link office sees about one every 6-7 shifts and
      a big network sees them constantly. Mix: 70% desk patch cable, 20% uplink/server/printer cable, 7% a PC's NIC
      dies (Device Manager Code 43, replace the card at the desk, 10 min), 3% a switch port dies (move the cable to a
      free port and configure it the same). Repairs: "Replace cable" on the switch front panel (2 min), new NIC at the
      desk. **MTBF** (time on shift / failures) and **MTTR** (failure to part replaced) in Monitor and the shift report.
      Later: optics, PSUs, fans, whole switches "once in a blue moon" scaled by network size (Phase 3 hardware)
- [x] **Skill radar (#27):** every fault block and ticket template is tagged with topics (`src/game/topics.ts`: physical,
      VLANs, STP, DHCP/DNS, routing, ACLs, NAT, security, endpoints, ops). Your score per topic is the average of your
      last 20 tickets in it: fixed yourself instantly 100, at the deadline 60, late down to 30, a senior's fix 20;
      -30 per false resolve, -15 for Owen's hint; employee and delegated fixes don't count. Radar in the Team view.
      **Decided (owner):** the generator stays realistic, mostly common incidents, and never aims at your weak topics.
      Instead a **growth bonus** pays for fixing a ticket in a topic you're weak at: by your weakest topic on the
      ticket (radar before this ticket), +50% of base points at a score of 0, falling linearly to nothing at 70+; an
      untried topic counts as 35 (+25%). Not on the tutorial, a second attempt, a ticket Owen hinted, or menial work
- [x] **Stale docs (#47a, #50), owner's version:** docs go stale on their own as the network changes; what matters is
      that **employees learn from your docs automatically** (`src/game/docfacts.ts`). They read the notebook and the
      inherited docs (with your edits) and pick up facts: who sits on which switch port and VLAN, device and server
      IPs, where servers and printers plug in. For each thing they need they trust the most recently updated doc.
      Right about the ticket: +10% chance to fix (+15% if it's your own note or edit) and 15% faster. Stale: -35%, they
      look in the wrong place and say so when they hand it back ("I went by the Desk and port map..."), and a junior
      out of their depth may shut the port the doc pointed at, hurting whoever sits there now. Nothing flags a stale
      doc for you

- [x] **Recurring incidents are normal:** like a real NOC, most tickets come from a handful of common problems (a shut (generator weights the regulars)
      port, an unplugged cable, a wrong VLAN, a printer, a driver). The generator weights a few "regulars" heavily and
      mixes in rarer ones, so repeats in a shift are expected; variety comes from who, where and how it presents

**Done when:** a player can work back-to-back shifts with a realistic mix: familiar recurring incidents plus enough rare ones to stay sharp.

---

## Phase 2.5: Python automation (owner, Nov 28 2026: its own phase, right after Phase 2)
Estimated at 5-7 working sessions. Possibly a paid feature later.
- [ ] `python` on NOC-PC opens a Python prompt (Pyodide, loaded from a CDN on first use so the game file stays small);
      scripts live as notebook notes
- [ ] A made-up `netsmart` library in the style of Netmiko/NAPALM: `connect(ip)`, `send_command('show ...')` (exactly
      the console's output), `send_config([...])`, `ping`, `snmp_get`, `syslog()`, plus a ticket API. Scripts see only
      what an engineer could see (CLI output, SNMP, logs), never game internals. Each command costs game time;
      errors are real Python tracebacks
- [ ] Scheduled jobs on NOC-PC's clock (game time); employees can run your scripts as runbook steps
- [ ] Uses: config backups across every device, audits (unused ports shut, weak passwords, SSH v2, NTP), bulk
      changes (a VLAN on every trunk, password rotation; a bug in a loop really breaks 20 ports), health polling and
      auto-declared incidents, careful auto-fixes, inventory and docs from neighbor discovery, triage scripts, before/
      after checks for change requests
- [ ] Automation-type tickets and how they're scored; unlocks at Network Engineer or with an automation cert
- [ ] Tests run real Python against the sim; example scripts

---

## Phase 3: Career, world, company and budget

- [ ] **Weekend maintenance shifts (owner's idea, Nov 2026, decided):** 2 of every 7 shifts are the weekend. The office
      is empty: no user tickets, and the weekend doesn't affect your score at all (no points gained or lost, no
      drain, no healthy income, neutral for the reliability streak and promotion count). It's your safe zone for
      major changes (re-cabling, NSOS upgrades with reloads, re-addressing, adding gear).
      - You can skip a weekend, but the game suggests what to do with it, because it's meant to teach: "A good time
        to audit and document your equipment, or make major infrastructure changes", plus ideas drawn from your own
        network (undocumented devices, old NSOS versions, no config backups, unused ports left open...)
      - Change requests carry an urgency: critical ones (e.g. a security vulnerability) must be done immediately on
        a weekday; routine ones (e.g. setting up a new VLAN) can be scheduled into the weekend
      - No on-call by default (nobody is in the office). The one exception: a security breach can call you in
**Goal:** a long-term progression arc with money that matters.

- [x] **Ranks (#22) up to NOC Manager** and SLA tiers by rank (#43), 90% → 99.999% (built in Phase 1, see above)
- [ ] **Multi-site is gated by rank (owner's rule):** a NOC Manager runs one facility. The Riverside branch and any other
      site stay locked until the rank above NOC Manager (multi-facility management). Until then, dynamic routing runs
      inside HQ (CR-CORE1 <-> CR-RTR1)
- [ ] **Ranks above NOC Manager** (Director → CTO and beyond): promoted on other prerequisites, such as facilities managed
- [ ] **Physical cabling:** cables are real objects. Open a device's **port view**, take a cable from your inventory, plug
      one end in (a dangling half-connection), then plug the other end into the far device. It has to be the right kind:
  - Copper by real standards: Cat5e / Cat6 / Cat6a with their speed and 100 m distance limits (Cat6 10G only to ~55 m),
    straight-through vs crossover where auto-MDIX isn't available, console (rollover) cables
  - Optional fiber: multimode (OM3/OM4) vs single-mode (OS2), LC/SC connectors, distance limits per optic
  - Transceivers: SFP (1G), SFP+ (10G), QSFP+/QSFP28 (40/100G), SR/LR types that must match the fiber and each other.
    Wrong optic, wrong fiber, too long a run or a speed the port can't do = link down or errors, with realistic logs
  - Cables and optics come out of inventory and the budget; tickets like "new desk needs a drop" or "uplink to the new
    closet"
- [ ] **Shop console (NetSmart store):** buy switches, routers, firewalls, cables, optics and spares from the budget, with
      delivery times; purchases land in your inventory
- [ ] **Top-down world map (#6, #44):** click through facilities; new sites unlock as the network grows
- [ ] **Budget (#55), early game:** start with $2,000 for consumables (patch cables, optics, a spare switch)
  - Quarterly budget from the business, raised or cut based on your SLA record and audit results
  - Capital spend (hardware, new sites) vs operating spend (salaries, ISP circuits, licenses, cloud, training)
  - Running out has consequences: no spare cable means a desk stays dead until a purchase order clears
- [ ] **Budget dashboard:** balance, quarterly budget, spending by category (salaries, hardware, ISP circuits, licenses,
      cloud, training), payroll per tech, burn rate and forecast, purchase history
- [ ] **NetSmart vendor contact (#54):** order parts with delivery delays; support contracts speed up RMAs
- [ ] **Company policy (#52, #52c):** naming conventions first, later banners, SSH-only, saved configs, change windows, NTP/logging, VLAN standards
- [ ] **Unannounced audits (#52b):** no reminders; heavy penalties; techs' violations count against you
- [ ] **Marty, the change advisory board (#11):** risk assessments for major changes, emergency changes during incidents
- [ ] **The VP (#38):** an insufferable jerk who pings you during outages
- [ ] **Calling the ISP (#17):** open a carrier ticket with the circuit ID; carrier response times by contract tier
- [ ] Configuring trusted SSH keys from the CLI (`ip ssh pubkey-chain` sub-mode) and `ssh-keygen` on the NOC PC
- [ ] Vaguer tickets and silent users at higher ranks (#9)

**Done when:** a player can climb from Tier 1 to Network Engineer over a multi-site network on a real budget.

---

## Phase 4: Team, training and specializations

### Team batch, approved Nov 2026 (built Nov 28 2026: runbooks, triggers, intern, employee scores, priorities, Team view, training and certificates; paid hiring waits for the budget)
- **Intern (from Tier 2):** one intern at Tier 2 and Network Engineer. Follows your runbooks; low skill, typos, slow.
  Promotion: 200+ points a shift for 5 shifts in a row makes them a Tier 1 NOC tech and pays you **1,000 points**.
  Term: the internship lasts 15 shifts; not promoted by then, they leave and you can take a new intern (confirmed)
- **Employee points:** their fixes are scored like yours and count toward your shift score, and each employee keeps
  their own shift score (plus lifetime points, tickets, mistakes) that you can monitor
- **View employees' runbooks** (their own ones are view-only and leave with them)
- **Runbook scripting (decided):** runbooks are notebook notes. Highlight lines and mark them "This is a command"; marked
  lines are typed in order from the NOC PC, the rest is explanation. Placeholders fill in from the ticket ({pc}, {ip},
  {switch} = access switch management address for `ssh {switch}`, {switchname}, {port} like Fa0/7, {floor},
  {printer}, {core}, {router}). Employees make typos by skill (intern ~8% a command, tech 1-2%); careful ones retype
  after an error. When done, the network is checked: fixed -> they resolve and tell the user; not fixed -> handed back
  with the log of what they typed and what the devices answered. **Players can script runbooks from Tier 1, before
  they can get an intern**, with a trigger tester (which tickets would have matched) and a dry run (commands with
  the placeholders filled in for a chosen ticket)
- **Runbook triggers (owner's syntax):** a list of statements, one per line, each made of phrases joined by OR / AND.
  If any line is true, the runbook runs. Example:
  ```
  triggerword1 OR triggerword2
  triggerword3 OR triggerword4
  triggerword5 AND triggerword6
  ```
  Phrases match anywhere in the ticket subject or description, case-insensitive, and can contain spaces. AND binds
  tighter than OR within a line. Operators are uppercase so a phrase can contain a lowercase "and"/"or"
- **Training time:** counted in real time while the game is running (not paused or closed)
- **Techs act on your priorities:** employees work tickets in the order of the priority you set
- **Hiring paid employees waits for the budget** (no salaries without it). Team size is whatever you hire: 1 intern at
  Tier 2 and Network Engineer; from NOC Manager it's entirely up to you
- **Management console:** roster, skills, morale, workload, points, runbooks; fire, raise, promote, demote, train
- **Training in real time:** from 10 real minutes (easy) to 4 real hours (hard); they do no tickets while training.
  Bundle training levels into made-up NetSmart certificates; hiring can require a certificate
- **Approved and built Nov 28 2026:** topic skills per employee raised by certificates (NSCT desk/cabling;
  NSCA VLANs, trunks, addressing, DHCP/DNS, ACL basics, NAT, monitoring; NSCS advanced ACLs, port security, snooping/
  DAI, hardening; NSCP dynamic routing, STP/EtherChannel/VTP, backups/upgrades; no "troubleshooting method" topic);
  every fault and ticket tagged with a topic; employees can work **without** runbooks (slower, success by topic skill
  vs difficulty, juniors occasionally make it worse) and pick up tickets on their own only when confident; a simple
  rule-based **chat with each employee** ("take INC-1004", "use <runbook> on INC-1004", "drop it", "status",
  "train NSCA", "focus on printers" / "only P1s" / "anything"), and they message you about pickups, fixes, hand-backs
- **Learning by doing (owner's idea, built):** every ticket an employee works (fixed or not) raises its topics: **+2%
  for a one-topic ticket, +3% each for two topics, +4% each for three or more** (owner: tickets that span topics teach
  how they interact, so they're worth more per topic). They report what improved ("VLANs +3%, ACLs +3%")
- **As built:** certificates add topic skill (NSCT physical/endpoints +20, VLANs +10; NSCA VLANs/DHCP-DNS +25, ACL/NAT
  +15, routing/ops +10; NSCS security +35, ACLs +25, ops +10; NSCP routing +35, STP +30, ops +20, VLANs +10); a new
  intern starts at 15 physical/endpoints, 10 VLANs, 5 elsewhere. Without a runbook their chance is 50% + (skill in
  the ticket's weakest topic - what the difficulty needs: 10/25/45/65/80) / 40, plus or minus your docs, capped
  3-95%; they pick tickets up on their own at 70%+ within their focus (anything, only P1s, only one topic, or only
  what you hand them). A runbook match always comes first. Assign from the ticket with or without a runbook
- Later (not this batch): specializations, managing managers, budget and shop consoles, Python lab

**Goal:** the late game shifts from firefighting to building and running a NOC.

- [x] **Your first employee is an intern, at Tier 2:** you are responsible for training and mentoring them, and this is
      where runbooks first matter (they follow yours). Interns are nearly free but bad at this: very low skills, slow,
      high mistake rate, need supervision, and leave at the end of their term. Train a good one and offer them a real job
- [ ] **Hiring tab (unlocks at NOC Manager):** browse and filter resumes: name, skills, years in the industry, salary
      ask. Interns can be hired here too, with their obvious downsides
- [ ] **Employee management console:** roster with skills, salary, morale and workload; fire, give a raise, promote,
      demote. A demoted (or underpaid, or overworked) employee **may** just quit
- [ ] **Employees bring their own runbooks:** experienced hires arrive with runbooks you can view and they use, but
      they are not added to your docs. When they leave, their runbooks leave with them
- [ ] **Managing managers (top ranks):** past a certain size you stop managing technicians directly. You run ~10
      managers, each running their own team, instead of 1,000 Tier 1 techs. The job becomes much less technical and
      much more "running the people who do the technical stuff"
- [ ] **Hire NOC techs (#45, #45a):** salary vs skill; juniors make mistakes; they act on *your* ticket priorities
- [ ] **Skills per tech:** each tech has skill levels per category (switching, routing, ACLs, wireless, cloud...) that decide
      which tickets they can handle and how likely they are to make it worse
- [x] **Training:** "Train Dave on ACLs." Choose a tech and a topic; pick the method: (built as real-time NetSmart certificates; topic skills proposed)
  - Paid course: costs money, Dave is unavailable for a few hours of game time, big skill gain
  - Shadowing you: free, but you work slower while you teach
  - Lab practice: cheap and slow, small gains
  - Certifications (CCNA, Security+, cloud) as milestones that unlock specializations and raise salary expectations
- [ ] **Specializations, first wave: Network Security (S1) and Cloud Architect (S2).** A trained tech can specialize,
      gaining perks and handling that domain's tickets on their own. These two ship with hiring; the rest come in Phase 5.
  - Network Security builds on Wave A ACLs and the Wave B firewall, VPN and 802.1X
  - Cloud Architect needs cloud basics, so those move into this phase (below)
- [ ] **Cloud basics (for Cloud Architect):** one cloud provider, cloud networks/subnets, security groups, route tables,
      a VPN to on-prem, and a monthly bill; scale, compliance and hybrid strategy come in Phase 5
- [x] **Runbook scripting (#46, #53):** write a runbook as ordinary text, then highlight lines and mark them
      **"This is a command"**. An employee following it types the marked commands top to bottom on the right device,
      reading the rest as instructions. Steps can be assembled and reordered; one-click runs for your own use; misuse
      during change freezes costs you
- [x] **Runbook triggers:** match keywords (and later alert types) to runbooks, so a ticket like "printer offline" is
      picked up and worked automatically by an employee assigned to that runbook. Bad matches and stale runbooks make
      things worse, so they need maintaining
- [x] **Menial work costs seniors points (first version built):** at NOC Supervisor and NOC Manager, resolving a
      trivial or easy ticket yourself earns nothing and costs 10% / 20% of its base points, so your score always ends
      up lower than before. Jordan and Owen
      now work for you at those ranks: **Assign** a ticket down to them for full base points and no penalty
- [ ] **Automation over manual work:** the same penalty applies once hired techs and runbook triggers exist; the
      intended play is delegation and automation so you focus on the hard tickets
- [ ] **Mentoring and promotion (#22):** promote techs; unhappy or underpaid techs can quit
- [ ] Ticket volume scales so time management matters (#1)
- [ ] Wave B configuration features

**Done when:** at NOC Manager rank, specialized techs resolve routine incidents from your runbooks and you handle escalations.

**Specializations** (S1 and S2 ship first, in Phase 4; S3-S12 follow in Phase 5):

| # | Specialization | What they're good at | Perk in the game |
|---|---|---|---|
| S1 | Network Security | ACLs, firewalls, VPNs, 802.1X, incident response | Handles security tickets alone; fewer audit findings |
| S2 | Cloud Architect | Cloud networks, security groups, hybrid links, cost tuning | Lowers cloud bills; designs migrations |
| S3 | Wireless Engineer | Controllers, APs, RF, site surveys | Owns Wi-Fi tickets; unlocks wireless builds |
| S4 | Routing and WAN | OSPF, BGP, VPNs between sites, ISP relations | Faster multi-site outages; better carrier escalations |
| S5 | Automation (DevNet) | Scripts, APIs, Ansible-style playbooks | Automated runbooks run safer and cheaper |
| S6 | Monitoring and Observability | SNMP, NetFlow, alert tuning | Less log noise and fewer red herrings for the whole team |
| S7 | Data Center | Core switching, servers, storage traffic, power and cooling | Handles server-room and data-center tickets |
| S8 | Voice and Collaboration | VoIP, QoS, phone systems | Owns call-quality tickets |
| S9 | Compliance and Audit | HIPAA/PCI rules, policy checks, evidence | Audit prep; lower audit penalties |
| S10 | Field Technician | Cabling, desk visits, hardware swaps | Faster walking and on-site fixes; cable plant upkeep |
| S11 | Identity and Access | AAA, RADIUS/TACACS+, directory integration | Owns login and 802.1X tickets |
| S12 | Service Desk Liaison | User chat, status updates, triage | Calms the office; better first-time priorities |

---

## Phase 5: Scale: big budgets, cloud and hybrid
**Goal:** the network grows from one office to dozens of facilities and the budget from thousands to billions.

- [ ] **Budget at scale:** contracts, acquisitions and growth push budgets into the millions, then billions; mergers bring
      whole new networks (with their own stale docs) to absorb
- [ ] **Specializations, second wave:** S3-S12 (Wireless, Routing and WAN, Automation, Monitoring, Data Center, Voice,
      Compliance and Audit, Field Technician, Identity and Access, Service Desk Liaison)
- [ ] **Cloud at scale (costs real money):** move more services, like the file server or apps, to the cloud
  - Monthly bills that grow with usage, plus data-transfer charges
  - Simplifies the on-prem network (fewer servers and closets to fail)
  - New failure modes: internet or VPN dependency, provider outages, misconfigured security groups, surprise bills
  - A cloud console: networks/subnets, security groups, VPN gateways, a cost dashboard
- [ ] **Compliance rules force some systems on-prem** (e.g., a hospital's patient records, a bank's core systems);
      the winning strategy is a hybrid balance, and audits check where regulated data lives
- [ ] **Hybrid connectivity:** site-to-site VPN or dedicated links between data centers, offices and cloud
- [ ] Multi-region operations, follow-the-sun shifts, larger incidents with several root causes (see the concept video)
- [ ] Wave C configuration features, unlocked through specializations

**Done when:** a player runs a hybrid, multi-site network with a nine-figure budget and justifies every on-prem vs cloud choice.

---

## Phase 6: Seasons, achievements, polish
- [ ] **Seasons (#36):** the organization rotates (hospital, school district, ISP, bank...) with different priorities and
      compliance rules; rank carries over
- [ ] **Achievements (#26):** "Have you tried turning it off and on again?", Ghosted, Marty Approved, Paper Trail, Penny Pincher,
      Hands Off, Nine Lives, Not My Fault, Read the Logs, The VP Can Wait, Stale Bread (hidden), Mentor
- [ ] Sound, visual polish, accessibility, settings
- [ ] Balancing pass (scores, SLA drain, audit penalties, budget, cloud costs)

---

## Phase 7: Accounts, monetization, launch
- [ ] **Supabase auth** (email / OAuth)
- [ ] **Free tier (#28):** one shift a day that ends after 5 resolved tickets, full network access, no ads (#31)
- [ ] **Server-side daily limit check (#34),** so clearing browser data doesn't reset it
- [ ] **Stripe subscription, $3/mo (#33):** unlimited shifts
- [ ] Cloud save sync (optional, nice to have)
- [ ] Optional AI-written chat replies (the game decides the facts, a model phrases them)
- [ ] Landing page: "practice Cisco IOS commands", no Cisco branding or implied affiliation
- [ ] Deploy to a static host + Supabase + Stripe webhook

> Phase 7 could be moved earlier (after Phase 2) to start earning revenue sooner with a smaller game.

---

## Back burner
3 (puzzle mode), 4 (hybrid campaign), 24 (post-incident RCA report), 25 (daily challenge / leaderboard), 29 (sandbox mode and paid extras),
30 (classroom tier), 35 (mobile), 37 (night shift), 39 (player-made scenarios), 47b (notes feed runbooks),
47c (inherited docs at new sites), 50a (predecessor runbooks wrong from day one), 52a (policy updates arrive as emails)

## Open questions
- Optional in-browser LLM for chat later (WebLLM, needs WebGPU and a large download): yes/no
- Release after Phase 2 (early access) or after Phase 6?
- ~~Downtime drain scale~~ decided Nov 2026: keep it (2 per affected user per service per minute, so 10 a minute for
  someone with nothing working)
- ~~10× speed~~ decided Nov 2026: a 1×-100× slider (logarithmic). Income and drain are per game minute, so speed
  doesn't change what a shift is worth
