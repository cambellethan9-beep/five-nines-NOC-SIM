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
- [x] **Router-on-a-stick and ISL:** spare CR-CORE1 Fa0/23 to CR-RTR1 Gi0/2 cable (in the docs) makes ROAS possible;
      `encapsulation isl` on router subinterfaces and `switchport trunk encapsulation isl|negotiate` on L3 switches;
      ISL and dot1Q ends don't interoperate

**Done when:** a new player can finish the tutorial and a short shift of handcrafted tickets, and get scored.

---

## Configuration coverage plan
So players never hit a ceiling, IOS features arrive in three waves. Each feature brings its `show` commands, realistic
error messages, the faults it can cause, and ticket templates that use it.

**Wave A: CCNA core (Phase 2, next).** Without these, CCNA-level players run out of things to learn.
- [ ] Output filters: `| include`, `| exclude`, `| section`, `| begin`
- [ ] `show mac address-table`, `show interfaces counters errors`, duplex mismatch symptoms (CRC, late collisions)
- [ ] **ACLs:** standard, extended, named; wildcard masks; `ip access-group in/out`; `access-class` on vty lines; hit counters
- [ ] **NAT/PAT:** inside/outside, overload, static NAT for servers (replaces the ISP routing stand-in)
- [ ] **DHCP:** IOS DHCP server, pools, exclusions, `ip helper-address`; PCs switch to DHCP clients (169.254.x.x when it fails)
- [ ] **DNS:** `ip name-server`, `ip host`, PCs resolve names (ping by name, "websites won't load but 8.8.8.8 works")
- [ ] **Syslog:** `logging host`, `logging trap`, `service timestamps`; devices only appear in the Logs tab once configured
- [ ] **NTP:** client/server, `show ntp status`, clocks finally leave 1993
- [ ] **SNMP:** communities, v2c vs v3; devices only appear in Monitor once configured
- [ ] **OSPFv2:** single and multi-area, neighbor states, area/timer/MTU mismatch, passive interfaces, router IDs, cost, DR/BDR
- [ ] **STP (PVST+):** root bridge, PortFast, BPDU guard, loops and broadcast storms
- [ ] **Port security:** max MACs, sticky, violation modes, err-disabled, `errdisable recovery`
- [ ] **EtherChannel:** LACP/PAgP, mismatched members, suspended ports
- [ ] **VTP:** modes, domain, the revision-number wipe
- [ ] Hardening: `service password-encryption`, `exec-timeout`, `login block-for`, login/exec banners, `security passwords min-length`
- [ ] Config backup and restore: `copy run tftp`, `archive`, `configure replace`

**Wave B: multi-site and security (Phase 3-4, as the network grows past one building).**
- [ ] **Site-to-site VPN** (IPsec, GRE over IPsec) and WAN links between facilities
- [ ] **HSRP** first-hop redundancy; dual ISP circuits
- [ ] **BGP basics:** eBGP to the ISP, dual-homing, prefix filtering (beyond CCNA, needed at ISP scale)
- [ ] **IPv6:** addressing, SLAAC, static routes, OSPFv3
- [ ] **DHCP snooping and dynamic ARP inspection** (rogue DHCP server tickets)
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

- [ ] **Fault library framework (#21):** each fault = preconditions + injection + symptoms + ticket templates + verification
- [ ] **CCNA core configuration, built in this order** (Wave A; each with its `show` commands, IOS errors, faults and tickets):
  1. [ ] Output filters: `| include`, `| exclude`, `| section`, `| begin` (cheap, used constantly)
  2. [ ] ACLs: standard, extended, named; wildcard masks; `ip access-group in/out`; `access-class` on vty lines; hit counters
  3. [ ] NAT/PAT: inside/outside, overload, static NAT for servers (replaces the ISP routing stand-in)
  4. [ ] DHCP: IOS DHCP server, pools, exclusions, `ip helper-address`; PCs become DHCP clients (169.254.x.x on failure)
  5. [ ] DNS: `ip name-server`, `ip host`, name resolution on PCs ("websites won't load but 8.8.8.8 works")
  6. [ ] Syslog, NTP and SNMP: `logging host`/`trap`, `service timestamps`, NTP client/server, SNMP v2c/v3; devices only
         appear in Logs and Monitor once configured
  7. [ ] OSPFv2: single and multi-area, neighbor states, area/timer/MTU mismatch, passive interfaces, router IDs, cost, DR/BDR
  8. [ ] STP (PVST+, PortFast, BPDU guard), port security (sticky, violations, err-disabled, recovery), EtherChannel
         (LACP/PAgP), VTP (modes, domain, the revision wipe)
  9. [ ] Duplex-mismatch errors (CRC, late collisions), `show mac address-table`, `show interfaces counters errors`,
         password hardening (`service password-encryption`, `exec-timeout`, `login block-for`, banners), config backup
         and restore (`copy run tftp`, `archive`, `configure replace`)
- [ ] **Faults and tickets that use them:**
  - L1/L2: duplex mismatch errors, native VLAN mismatch, err-disabled (port security), STP loops, EtherChannel, VTP wipe
  - L3: wrong gateway, wrong IP/mask, missing static route, OSPF neighbor down (area/timers/passive), ACL blocking traffic
  - Services: DHCP scope exhausted / helper missing, DNS wrong, NTP drift, NAT broken after a router swap
  - Endpoint: APIPA address, wrong DNS on a PC
  - Upstream ISP outage (prove it with traceroute, then call the carrier with the circuit ID)
  - Red herrings, cascading failures with one root cause, an undocumented coworker change
- [ ] **Hard (220-point) ticket templates** (none exist yet)
- [ ] **Generator:** picks faults weighted by rank and skill-radar weaknesses; difficulty knobs (combined faults, noise, ticket vagueness, ghost users)
- [ ] **Real-time breakage (#2):** the network degrades on its own; **MTTR / MTBF** tracked
- [ ] **Skill radar (#27):** incidents tagged by category, scored on performance
- [ ] **Stale docs (#47a, #50):** network changes invalidate notes and predecessor runbooks

- [ ] **Recurring incidents are normal:** like a real NOC, most tickets come from a handful of common problems (a shut
      port, an unplugged cable, a wrong VLAN, a printer, a driver). The generator weights a few "regulars" heavily and
      mixes in rarer ones, so repeats in a shift are expected; variety comes from who, where and how it presents

**Done when:** a player can work back-to-back shifts with a realistic mix: familiar recurring incidents plus enough rare ones to stay sharp.

---

## Phase 3: Career, world, company and budget
**Goal:** a long-term progression arc with money that matters.

- [ ] **Ranks (#22):** Tier 1 → Tier 2 → Network Engineer → NOC Manager → Director → CTO; your rank is your badge
- [ ] **SLA tiers by rank (#43):** 90% → 99% → 99.9% → 99.99% → 99.999%
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
**Goal:** the late game shifts from firefighting to building and running a NOC.

- [ ] **Interns:** nearly free, but they barely know anything: very low skills, slow, high mistake rate, need supervision,
      and leave at the end of their term. Train a good one and you can offer them a real job
- [ ] **Hire NOC techs (#45, #45a):** salary vs skill; juniors make mistakes; they act on *your* ticket priorities
- [ ] **Skills per tech:** each tech has skill levels per category (switching, routing, ACLs, wireless, cloud...) that decide
      which tickets they can handle and how likely they are to make it worse
- [ ] **Training:** "Train Dave on ACLs." Choose a tech and a topic; pick the method:
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
- [ ] **Runbook editor (#46):** if-then steps that techs follow when an alert or ticket matches; assign playbooks to techs
- [ ] **Automated runbooks / macros (#53):** one-click command sequences; misuse during change freezes costs you
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
- Downtime drain scale: per user per service (current), per user, or halved?
- 10× speed: remove before launch, or keep it but exclude it from healthy-network income?
