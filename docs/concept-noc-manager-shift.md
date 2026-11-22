# Five Nines concept video: "A Shift at the Top"

A day in the life of a NOC Manager in Five Nines, scripted from the agreed roadmap.

**Runtime:** about 7 minutes. **Format:** screen capture of the game with voice-over (VO), short on-screen captions,
and game sound effects (SFX). **Tone:** calm, a little dry, like a manager who has seen everything twice.

Most of what's shown is planned for Phases 3-5 (budget, team, runbooks, multi-site, cabling, shop). Rank, promotion,
streak, delegation and the menial-work penalty already exist. The IOS commands and output are written to be accurate.

---

## Cast

| Who | Role | Notes |
|---|---|---|
| **You** | NOC Manager, Cedar Ridge Accounting | Top of the NOC ladder; no one to escalate to |
| **Ruth Alvarez** | NOC Supervisor, 15 years in the industry | Hired last quarter; brought her own runbooks |
| **Dave Lindqvist** | Network Engineer (NOC Tier 3) | Mid-training on ACLs; Network Security track |
| **Tasha Bell** | Tier 2 NOC Technician | Cloud Architect track |
| **Jordan Reyes, Owen Price** | Tier 1 and Tier 2 | The coworkers you started with now report to you |
| **Kevin Moss** | Intern | Second week. Means well |
| **Marty** | Change advisory board | Wants a risk assessment for everything |
| **Rick Dunmore** | VP of Operations | The jerk VP |
| **Gloria Haines** | Director of IT Operations | Your old manager, promoted |

**The network:** Cedar Ridge has grown to three sites. HQ (Cedar Ridge), the Riverside branch and the Northgate
office, linked by OSPF over WAN circuits. Payroll and LedgerWorks stay on-prem for compliance; the client portal runs in
the cloud over a site-to-site VPN.

---

## Scene 1: Cold open (0:00-0:25)

**SCREEN:** Black. A single syslog line types itself out, then the game's top bar fades in: `99.999` badge, "Five
Nines", "NOC Manager", Shift 214.

```
*Apr 14 07:58:02.317: %LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet1/0/14, changed state to down
```

**VO:** "Five nines is twenty-six seconds of downtime a month. Nobody actually hits it. The job is getting close, and
making sure the people who work for you can get close without you."

**CAPTION:** NOC Manager · Shift 214 · Reliability streak: 11

---

## Scene 2: Morning standup in the employee console (0:25-1:20)

**SCREEN:** The **Team** tab. A roster table: name, rank, skills radar thumbnail, workload, morale, salary, current
assignment. Ruth: morale high. Dave: "In training: ACLs (62%)". Kevin: an orange "Supervised" tag. Owen's morale is
yellow.

**VO:** "First thing every shift: the people. Software doesn't call in sick. These folks do."

**SCREEN:** Hover Owen. Tooltip: *"Hasn't had a raise in 4 quarters. Market rate for Tier 2: $68k. Current: $61k."*

**VO:** "Owen taught me half of what I know. He's also been underpaid for a year, and the game knows it."

**SCREEN:** Click **Give a raise** → slider to $67,500 → confirmation: *"Payroll +$6,500/yr. Owen's morale: ▲."*
The budget widget in the corner ticks down.

**VO:** "Cheaper than replacing him. Way cheaper than training his replacement."

**SCREEN:** Hover Kevin. His last three tickets: two resolved, one "made it worse" in red.

**VO:** "Kevin's the intern. He's not good yet. That's fine, that's what interns are. What's not fine is giving him
work without a runbook."

---

## Scene 3: The budget (1:20-2:05)

**SCREEN:** The **Budget** dashboard. Q2 budget: $1.42M. Spent: $611k. A stacked bar: Salaries 64%, Hardware 14%,
ISP circuits 9%, Cloud 8%, Licenses 3%, Training 2%. A forecast line crosses the budget line about two weeks before
quarter end.

**VO:** "Here's the problem with being good at this: the business notices, they grow, and the budget doesn't grow as
fast as the network does."

**SCREEN:** Zoom on Cloud: $38k this quarter, trending up. Click it: the client portal's egress traffic doubled after a
marketing campaign.

**VO:** "Cloud is great until the bill comes. The portal can stay up there. Payroll and LedgerWorks can't move at all.
Compliance says they live on-prem, in a room we control. So the answer is hybrid, and the trick is keeping the
expensive half small."

**SCREEN:** Tasha's name next to a pending item: *"Proposal: cache static portal assets at the edge. Est. savings
$4k/month."* Click **Approve**.

**VO:** "Tasha's on the Cloud Architect track. That's her call to make, and she made a good one."

---

## Scene 4: The shop (2:05-2:40)

**SCREEN:** The **NetSmart Store** ("the only networking vendor ever!"). Cart: 2× NS-3850-48P switch, 4× SFP-10G-LR
optics, 1× 500 ft box of Cat6a, 10× LC-LC single-mode patch cables. A delivery estimate: 3 business days. Support
contract checkbox: "Next-business-day RMA" ticked.

**VO:** "Northgate is getting a second closet. Ten-gig uplink, about two hundred and eighty meters back to the main
closet. Copper's out at that distance; Cat6a stops at a hundred meters. So it's single-mode fiber and LR optics."

**SCREEN:** Change one line from SFP-10G-**SR** to SFP-10G-**LR**. A small tooltip on the old item: *"SR: multimode,
up to 300 m on OM3. Your run is single-mode."*

**VO:** "Last quarter someone ordered SR optics for a single-mode run. The link came up dark and stayed that way. That
someone was me."

**SCREEN:** Click **Submit purchase order**. Marty pops up in chat: *"Is this tied to a change request?"*
Reply: *"CR-1187, Northgate closet build, approved Thursday."* Marty: *"👍"*

---

## Scene 5: Runbooks and automation (2:40-3:50)

**SCREEN:** The **Runbooks** tab. A list: "Port shut on an access switch", "User on APIPA", "Stale DNS cache",
"Printer offline". Under a separate header: **Ruth's runbooks (hers, not yours)**, greyed, with a lock icon:
"Ruth: OSPF neighbor down", "Ruth: err-disabled ports".

**VO:** "Ruth brought her own runbooks when she joined. Her team can use them. They aren't mine, and when she leaves
they leave with her. Which is a good reason to write my own."

**SCREEN:** Open "Port shut on an access switch". It's plain text. Some lines are highlighted with a **Command** chip:

> 1. Find the user's switch and port in the port map.
> 2. `ssh nocadmin@<switch-ip>` **[Command]**
> 3. `show interfaces <port> status` **[Command]**
> 4. If the status is **err-disabled**, stop and assign to a Tier 2. Don't just bounce it.
> 5. `configure terminal` **[Command]**
> 6. `interface <port>` **[Command]**
> 7. `no shutdown` **[Command]**
> 8. `end` **[Command]**
> 9. `write memory` **[Command]**
> 10. Ask the user to confirm, then resolve.

**VO:** "You write it like you'd explain it to a person, then you mark which lines are commands. Whoever runs it types
those, top to bottom, on the right device. Step four matters. An err-disabled port that you just bounce comes right
back down, and now you've hidden the real problem."

**SCREEN:** The **Triggers** panel. Keyword rules: `"no network" OR "internet down" AND single user` → "Port shut on an
access switch" → assigned to: Jordan, Kevin (supervised). `"printer"` → "Printer offline" → Owen.

**VO:** "Triggers are what turn a runbook into automation. A ticket comes in, the keywords match, the right person
picks it up and follows the script. I don't touch it."

**SCREEN:** A new ticket slides into the queue: *"INC-4471: Riverside: no network at desk R-2-07."* A badge appears:
*"Matched: Port shut on an access switch → Jordan."* It resolves on its own ninety seconds later. The score ticker:
**+80**.

**VO:** "That's the dream. Eighty points I didn't earn and don't have to."

---

## Scene 6: The temptation (3:50-4:20)

**SCREEN:** Another ticket: *"INC-4473: HQ: Fa0/9 shut after a desk move."* No trigger matched; the reporter wrote
"desk move". The ticket sits unassigned. The player opens a console on CR-ACC1, types `int fa0/9`, then pauses
over `no shut`.

**VO:** "Here's the trap. This takes me fifteen seconds. But I'm the NOC Manager. If I do it by hand, I get nothing for
it, and I lose points for doing it at all."

**SCREEN:** A preview tooltip on the Resolve button: *"Routine ticket done by hand: no credit, −8."*
Backspace. Close the console. Click **Assign to Owen**. Then open Triggers and add `"desk move"` to the rule.

**VO:** "Fix the ticket once, or fix the trigger forever. That's the whole job now."

---

## Scene 7: The automation misfire (4:20-4:55)

**SCREEN:** Kevin's ticket turns red: *"Made it worse."* The ticket: *"INC-4474: Northgate printer offline and nobody on
floor 2 can print."* The trigger "printer" sent it to Kevin, who followed "Printer offline", which bounces the
printer's port. But it's the whole floor, not one printer.

```
NG-ACC2#show interfaces status | include Gi1/0/48
Gi1/0/48  Uplink to NG-CORE1   notconnect   1            auto   auto 10/100/1000BaseTX
```

**VO:** "Keyword triggers are dumb on purpose. 'Printer' matched, but the real problem is the floor 2 uplink, and the
runbook for a single printer can't fix that. Kevin did exactly what the runbook told him to."

**SCREEN:** Click the ticket → **Reassign to Ruth**. In the Triggers panel, edit the printer rule: add the condition
`single device` and a fallback `"nobody" OR "whole floor" → Supervisor`.

**VO:** "Not Kevin's fault. Mine. I wrote the trigger."

**SCREEN:** Chat with Kevin: *"You did fine. The runbook was wrong. Want to shadow Ruth on this one?"* Kevin: *"yes
please"*. A small tag on Kevin: *"Training: shadowing (+skill: switching)."*

---

## Scene 8: The hard ticket (4:55-6:15)

**SCREEN:** The queue flashes. **P1**: *"INC-4476: Riverside branch can't reach LedgerWorks or the file server.
Payroll run is today."* No trigger matches. The SLA clock reads 15:00 and starts counting down. Chat lights up: Rick
Dunmore, VP: *"Payroll is TODAY. Why is Riverside down. Call me."*

**VO:** "This one's mine. Not because I can't delegate it, but because nobody on the team has seen this one before, and
payroll doesn't wait."

**SCREEN:** Console on CR-WAN1 (HQ).

```
CR-WAN1#show ip ospf neighbor

Neighbor ID     Pri   State           Dead Time   Address         Interface
10.255.0.2        1   FULL/  -        00:00:34    10.255.12.2     GigabitEthernet0/1
10.255.0.3        1   EXSTART/  -     00:00:37    10.255.13.2     GigabitEthernet0/2
```

**VO:** "Northgate's FULL. Riverside's stuck in EXSTART. Two routers that can see each other but can't agree to swap
their databases. That's almost always an MTU mismatch."

```
CR-WAN1#show logging | include ADJCHG
*Apr 14 09:41:17.902: %OSPF-5-ADJCHG: Process 1, Nbr 10.255.0.3 on GigabitEthernet0/2 from EXSTART to DOWN, Neighbor Down: Too many retransmissions
*Apr 14 09:42:18.044: %OSPF-5-ADJCHG: Process 1, Nbr 10.255.0.3 on GigabitEthernet0/2 from DOWN to EXSTART, Neighbor Down: Too many retransmissions
```

**SCREEN:** SSH to RV-WAN1, then check the interface MTU on both ends.

```
CR-WAN1#show interfaces gi0/2 | include MTU
  MTU 1500 bytes, BW 1000000 Kbit/sec, DLY 10 usec,

RV-WAN1#show interfaces gi0/1 | include MTU
  MTU 9000 bytes, BW 1000000 Kbit/sec, DLY 10 usec,
```

**VO:** "There it is. Nine thousand on one side, fifteen hundred on the other. Somebody turned on jumbo frames at
Riverside."

**SCREEN:** The Logs tab, filtered to RV-WAN1:

```
*Apr 14 09:40:52.611: %SYS-5-CONFIG_I: Configured from console by dlindqvist on vty0 (10.10.99.21)
```

**VO:** "Dave. During the change window. Probably for the new storage replication project. He wasn't wrong to want
jumbo frames; he just didn't do both ends."

**SCREEN:** Marty pops up: *"Emergency change? I need a risk assessment."* Reply: *"Emergency change, restoring the
previous MTU on one interface. Risk: low. Rollback: re-apply 9000."* Marty: *"Approved. Document it after."*

```
RV-WAN1#configure terminal
Enter configuration commands, one per line.  End with CNTL/Z.
RV-WAN1(config)#interface gi0/1
RV-WAN1(config-if)#mtu 1500
RV-WAN1(config-if)#end
RV-WAN1#
*Apr 14 09:47:03.288: %OSPF-5-ADJCHG: Process 1, Nbr 10.255.0.1 on GigabitEthernet0/1 from LOADING to FULL, Loading Done
RV-WAN1#write memory
Building configuration...
[OK]
```

**SFX:** The soft chime of every Riverside service going green on the Monitor tab.

**SCREEN:** Resolve. Score lines: *"Expert ticket: +300 · Speed ×1.19 · P1 triaged correctly +30."* Total **+387**.
Rick Dunmore: *"ok."*

**VO:** "Three hundred and eighty-seven points, and a one-word thank-you from the VP. That's a good day."

---

## Scene 9: Closing the loop (6:15-6:45)

**SCREEN:** Open the Docs tab → "WAN links and OSPF" → **Edit**. Add a row to the table: `RV-WAN1 Gi0/1 | MTU 1500
(match HQ; jumbo needs both ends + CR)`. Save. "Updated by you 09:51."

**VO:** "Write it down. The docs don't update themselves."

**SCREEN:** Team tab → Dave → **Training** → "OSPF: adjacency troubleshooting" → method: *Shadowing* (free, slows you
down). Then the Runbooks tab: new runbook "OSPF stuck in EXSTART", with `show ip ospf neighbor` and
`show interfaces <if> | include MTU` marked as commands, and the trigger `"branch" AND ("can't reach" OR "down")` →
Ruth.

**VO:** "Dave learns it, Ruth gets a runbook for it, and next time it happens it's not my ticket."

---

## Scene 10: End of shift (6:45-7:10)

**SCREEN:** The end-of-shift report.

| Line | Value |
|---|---|
| Tickets resolved within SLA | 29 of 31 (94%), target 98%: missed |
| Service availability | 99.94%, target 99.999% (informational) |
| Handled by your team | 30 (19 picked up automatically by triggers) |
| Done by you | 1 (expert) |
| Ticket points | +5,187 |
| Points for a healthy network | +612 |
| Points lost to downtime | −618 |
| Shift penalty | −100 |
| Reliability streak | +750 (12 in a row) |
| **Shift score** | **5,831** (bar: 5,000) |

**VO:** "Missed the SLA target by a ticket. Missed five nines by a mile. Cleared the points bar by eighty-one points
before the streak bonus, so the streak keeps going. Twelve in a row. One bad shift and it's back to zero."

**SCREEN:** A banner below the table: *"Next: Director of IT Operations. Requires: 3 facilities managed (you have 3),
1 more Network Engineer on staff, a passed compliance audit."* Gloria in chat: *"Heard about Riverside. Nice catch.
We should talk about that Director role."*

**VO:** "The higher you go, the less of this is typing commands. It's people, money, and making sure the right
runbook exists before the problem does. You still need to know the commands. Somebody has to write the runbooks."

**CAPTION:** Five Nines · Learn the network. Then learn to run the people who run it.

---

## Production notes
- **Screen pacing:** hold each console output for at least 3 seconds; viewers will want to read it.
- **Numbers check (current rules):** Expert base 300 × 1.19 speed = 357, + 30 for correct triage = 387. Team tickets
  pay full base with no speed bonus: 30 at an average of 160 = 4,800, + 387 = 5,187. Before the streak:
  5,187 + 612 − 618 − 100 = 5,081, which clears the 5,000 bar, so the streak counts. Streak: 50 × 10 (cap) × 1.5 (five
  nines) = 750. Total 5,831. The shift penalty applies because ticket SLA (94%) is under the 98% target.
- **Features this depends on:** Team, Budget, Shop and Runbooks tabs (Phases 3-4), multi-site OSPF (Phase 2 item 7),
  physical optics (Phase 3), the Director rank (above Manager). Rank, streak, delegation and the menial-work penalty
  already exist in the game.
