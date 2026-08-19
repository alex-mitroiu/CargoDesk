import { useState } from "react";
import { T, IMDG_CLASSES, IMDG_CLASS_VARIANT } from "../tokens";
import Badge from "../components/primitives/Badge";
import IncotermsModal from "../components/shared/IncotermsModal";

// ─── User Manual Page ─────────────────────────────────────────────────────────
// Two complementary halves, matching how the CargoDesk Field Guide itself frames the split
// (its own closing chapter says so explicitly): a WALKTHROUGH that processes one shipment
// start-to-finish in the order you'd actually do it (quote -> shipment -> cargo -> schedule ->
// booking -> parties -> customs -> documents -> tracking -> money), and a REFERENCE half
// organized by topic instead of by sequence, for looking something up once you already know
// your way around. Ported from the Field Guide artifact — not a replacement for the reference
// half, which the guide's own final chapter points back to by name.

const UserManualPage = () => {
  const [section, setSection] = useState("welcome");
  const [showIncoterms, setShowIncoterms] = useState(false);

  const WALKTHROUGH = [
    { id: "welcome",   label: "Welcome" },
    { id: "quote",     label: "1. Get a Quote" },
    { id: "shipment",  label: "2. Create the Shipment" },
    { id: "cargo",     label: "3. Add Your Cargo" },
    { id: "schedule",  label: "4. Find a Sailing" },
    { id: "booking",   label: "5. Book the Carrier" },
    { id: "parties",   label: "6. Add Parties & Offices" },
    { id: "customs",   label: "7. Handle Customs" },
    { id: "documents", label: "8. Generate Documents" },
    { id: "tracking",  label: "9. Track the Shipment" },
    { id: "money",     label: "10. Handle the Money" },
    { id: "help",      label: "Getting Help" },
  ];
  const REFERENCE = [
    { id: "freight-basics",    label: "Ocean Freight Basics" },
    { id: "dashboard",         label: "Dashboard" },
    { id: "command-center",    label: "Command Center" },
    { id: "integration-board", label: "Integration Board" },
    { id: "ai-agent",          label: "AI Agent" },
    { id: "mdm",               label: "Master Data" },
    { id: "incoterms",         label: "Incoterms" },
    { id: "dg-classes",        label: "DG Classes ⚠" },
  ];

  const GroupLabel = ({ children }) => (
    <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.textMuted, fontWeight: 700,
      textTransform: "uppercase", letterSpacing: ".1em", padding: "16px 14px 6px" }}>{children}</div>
  );

  const SectionBtn = ({ id, label }) => (
    <button onClick={() => setSection(id)} style={{
      display: "block", width: "100%", textAlign: "left", padding: "8px 14px",
      background: section === id ? T.accentBg : "transparent",
      border: "none", borderLeft: `3px solid ${section === id ? T.accent : "transparent"}`,
      color: section === id ? T.accent : T.textMuted,
      fontFamily: T.body, fontSize: 13, fontWeight: section === id ? 600 : 400,
      cursor: "pointer", borderRadius: "0 6px 6px 0", marginBottom: 2,
    }}>{label}</button>
  );

  const H2 = ({ children }) => (
    <h2 style={{ fontFamily: T.head, fontSize: 20, fontWeight: 700, color: T.text, margin: "0 0 10px" }}>{children}</h2>
  );
  const H3 = ({ children }) => (
    <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.accent, margin: "20px 0 6px" }}>{children}</h3>
  );
  const P = ({ children }) => (
    <p style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.75, margin: "0 0 10px" }}>{children}</p>
  );
  const Tag = ({ children }) => (
    <code style={{ fontFamily: T.mono, fontSize: 12, color: T.textCode, background: T.bg,
      border: `1px solid ${T.border}`, borderRadius: 4, padding: "1px 6px" }}>{children}</code>
  );
  // Walkthrough-only primitives — a numbered step heading and a tip/warn/note callout box,
  // matching the Field Guide artifact's own visual language (stepnum badge, colored callout).
  const Dek = ({ children }) => (
    <p style={{ fontFamily: T.body, fontSize: 15, color: T.textMuted, lineHeight: 1.7, maxWidth: "62ch", margin: "0 0 26px" }}>{children}</p>
  );
  const Step = ({ n, children }) => (
    <h3 style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: T.head, fontSize: 15,
      fontWeight: 800, color: T.text, margin: "28px 0 6px" }}>
      <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, width: 22, height: 22, borderRadius: 6,
        background: T.accentBg, color: T.accent, display: "inline-flex", alignItems: "center",
        justifyContent: "center", flexShrink: 0 }}>{n}</span>
      {children}
    </h3>
  );
  const StepBody = ({ children }) => (
    <div style={{ marginLeft: 32 }}>{children}</div>
  );
  const Callout = ({ type = "note", children }) => {
    const v = {
      tip:  { bg: T.accentBg,  border: T.accent + "55",  color: T.accent,     icon: "💡" },
      warn: { bg: T.warningBg, border: T.warning + "55", color: T.warning,    icon: "⚠" },
      note: { bg: T.bg,        border: T.border,         color: T.textMuted,  icon: "ℹ" },
    }[type];
    return (
      <div style={{ marginLeft: 32, marginBottom: 20, padding: "12px 15px", borderRadius: 8,
        background: v.bg, border: `1px solid ${v.border}`, display: "flex", gap: 10 }}>
        <span style={{ fontSize: 14, color: v.color, flexShrink: 0, lineHeight: 1.6 }}>{v.icon}</span>
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.65 }}>{children}</div>
      </div>
    );
  };

  const content = {
    // ── Walkthrough ──────────────────────────────────────────────────────────
    welcome: (
      <div>
        <H2>Welcome to CargoDesk</H2>
        <Dek>CargoDesk is where you plan, book, and track ocean freight shipments — from the first
          price you quote a customer to the last invoice you reconcile. This guide walks you through
          processing one shipment from start to finish, in the order you'd actually do it.</Dek>
        <Step n={1}>Sign in</Step>
        <StepBody>
          <P>Sign in with the email and password your administrator gave you. If you ever forget
            your password, use the <strong>Forgot password?</strong> link on the sign-in screen —
            don't ask a colleague to share theirs.</P>
        </StepBody>
        <Step n={2}>Get your bearings</Step>
        <StepBody>
          <P>Once you're in, the sidebar on the left is where every chapter in this guide begins:</P>
          <ul style={{ margin: "0 0 10px", paddingLeft: 20 }}>
            <li style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.8 }}><Tag>Quotes</Tag> — price a shipment for a customer before it's booked (Chapter 1)</li>
            <li style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.8 }}><Tag>Shipments</Tag> — every shipment you've created or are working on (Chapter 2 onward)</li>
            <li style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.8 }}><Tag>Dashboard</Tag> — how much container space you've used against what carriers gave you</li>
            <li style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.8 }}><Tag>Integration Board</Tag> — the internal task board the CargoDesk team uses, not customer-facing</li>
            <li style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.8 }}><Tag>Schedule Search</Tag> — a standalone sailing lookup, outside of any one shipment</li>
            <li style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.8 }}><Tag>AI Assistant</Tag> — ask it about any shipment, contract, or allocation in plain English (Getting Help)</li>
          </ul>
          <P>The home screen itself is worth a glance every morning: it shows your fleet-wide shipment
            counts, overdue milestones, and departures coming up in the next 7 days.</P>
        </StepBody>
        <Callout type="tip"><strong>This guide follows one shipment</strong> from a quote all the way to a
          reconciled invoice — the same order you'd work it in real life. Skip ahead to whichever chapter
          matches where your own shipment actually is.</Callout>
      </div>
    ),
    quote: (
      <div>
        <H2>1. Get a Quote</H2>
        <Dek>Not every shipment starts here — if you already know exactly what you're booking, skip
          straight to Chapter 2. But if a customer has asked "how much to ship 2 containers to New
          York," a <strong>Quote</strong> is where you answer that without committing to a real,
          numbered shipment yet.</Dek>
        <Step n={1}>Open Quotes and start a new one</Step>
        <StepBody>
          <P>Click <Tag>Quotes</Tag> in the sidebar, then <Tag>+ New Quote</Tag>. Fill in the customer,
            route (POL/POD), cargo basics, and — if you already know it — the carrier.</P>
        </StepBody>
        <Step n={2}>Price it</Step>
        <StepBody>
          <P>You have two ways to fill in the <Tag>Quote Lines</Tag> table at the bottom:</P>
          <ul style={{ margin: "0 0 10px", paddingLeft: 20 }}>
            <li style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.8 }}>Type each charge in yourself — a service code like <Tag>OF</Tag> for Ocean Freight, a description, and a rate.</li>
            <li style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.8 }}>Click <Tag>Find Matching Contracts</Tag> to pull rates from a contract already on file for that route and carrier, then adjust them — the contract rate is usually your cost, so add your margin before saving.</li>
          </ul>
          <P>Set a <Tag>Valid Until</Tag> date too — a quote needs one before you can send it, since
            an open-ended price isn't a real offer.</P>
        </StepBody>
        <Step n={3}>Send it, then track the answer</Step>
        <StepBody>
          <P>Save the quote — it starts as a <Badge variant="default">Draft</Badge>, which you can
            still edit freely. Once it's ready, send it to the customer; it locks and moves to{" "}
            <Badge variant="warning">Sent</Badge>. When they get back to you, mark it{" "}
            <Badge variant="success">Accepted</Badge> or <Badge variant="danger">Declined</Badge> —
            an accepted quote left untouched too long expires on its own.</P>
        </StepBody>
        <Step n={4}>Convert it to a real shipment</Step>
        <StepBody>
          <P>Once a quote is <Badge variant="success">Accepted</Badge>, click{" "}
            <Tag>Convert to Shipment</Tag>. CargoDesk creates a real, numbered shipment and carries
            your quoted price straight in as the SELL side of its cost lines — you don't re-type
            anything.</P>
        </StepBody>
        <Callout type="note">A quote's price doesn't have to match what you eventually pay the
          carrier. When the shipment converts, the SELL side comes from your quote and the BUY side
          comes from the actual contract — CargoDesk keeps them independent so your margin stays
          visible.</Callout>
      </div>
    ),
    shipment: (
      <div>
        <H2>2. Create the Shipment</H2>
        <Dek>A shipment is the one record everything else in this guide hangs off — cargo, booking,
          parties, documents, and money all attach to it.</Dek>
        <Step n={1}>Starting from an accepted quote</Step>
        <StepBody>
          <P>If you followed Chapter 1, you already have one — <Tag>Convert to Shipment</Tag> did
            this for you. Skip to Step 3.</P>
        </StepBody>
        <Step n={2}>Starting from scratch</Step>
        <StepBody>
          <P>From <Tag>Shipments</Tag>, click <Tag>+ New Shipment</Tag>. At minimum you need a Port
            of Loading, Port of Discharge, carrier, and contract type — everything else (dates,
            booking reference, B/L number, vessel, voyage) can be filled in later.</P>
        </StepBody>
        <Step n={3}>Know your shipment's home screen</Step>
        <StepBody>
          <P>Whichever path you took, you'll land on the shipment's <Tag>Overview</Tag> page. This
            is your dashboard for this one shipment — a persistent header up top shows route,
            carrier, and status on every sub-page you visit from here.</P>
        </StepBody>
        <Callout type="tip">Notice the sidebar below the shipment header — <Tag>Cargo</Tag>,{" "}
          <Tag>Contracts & Schedules</Tag>, <Tag>Carrier Booking</Tag>, <Tag>Parties & Offices</Tag>,{" "}
          <Tag>Documents</Tag>, and more all live there. The rest of this guide walks through them in
          the order that actually unblocks each other.</Callout>
      </div>
    ),
    cargo: (
      <div>
        <H2>3. Add Your Cargo</H2>
        <Dek>Before you can book a carrier or price anything properly, CargoDesk needs to know what's
          actually moving.</Dek>
        <Step n={1}>Add a container</Step>
        <StepBody>
          <P>Open <Tag>Cargo</Tag> in the shipment's sidebar and click <Tag>+ Add Container</Tag>.
            Give it a container number, size (20ft = 1 TEU, 40ft = 2 TEU), and equipment type
            (DC, RF, OT, FR, TK).</P>
        </StepBody>
        <Step n={2}>Describe what's inside</Step>
        <StepBody>
          <P>Click into a container and add the cargo itself — pallets, boxes, or crates, each with
            a description, quantity, and (once you know it) a declared value. This is also where
            you flag a container as Dangerous Goods and set its IMDG class if it needs one.</P>
        </StepBody>
        <Callout type="note"><strong>TEU is calculated for you.</strong> A 20-foot container counts
          as 1 TEU, a 40-foot as 2 — the total rolls up automatically to the shipment header and the
          Dashboard the moment you save a container.</Callout>
      </div>
    ),
    schedule: (
      <div>
        <H2>4. Find a Sailing</H2>
        <Dek>Before CargoDesk will let you book a carrier, it needs to know <em>which</em> sailing
          you're on — vessel, voyage, and dates.</Dek>
        <Step n={1}>Add a route leg</Step>
        <StepBody>
          <P>Open <Tag>Booking & Routing → Contracts & Schedules</Tag> in the sidebar. If this is a
            straightforward port-to-port move, add one SEA leg from your POL to your POD.</P>
        </StepBody>
        <Step n={2}>Search for a sailing and apply it</Step>
        <StepBody>
          <P>With a leg in place, <Tag>Add Sailing</Tag> becomes available. Search by the leg's own
            route and pick a real sailing — vessel, voyage, and ETD/ETA all copy onto the leg in one
            click.</P>
        </StepBody>
        <Callout type="warn"><strong>This is a hard gate, not a suggestion.</strong> If you jump
          straight to Carrier Booking without a contract and a schedule both in place, CargoDesk
          blocks you outright and sends you back here to finish first.</Callout>
      </div>
    ),
    booking: (
      <div>
        <H2>5. Book the Carrier</H2>
        <Dek>With cargo and a sailing both in place, you're ready to actually reserve space with the
          carrier.</Dek>
        <Step n={1}>What you'll see if you're not ready yet</Step>
        <StepBody>
          <P>Open <Tag>Booking & Routing → Carrier Booking</Tag>. If Chapter 4 isn't done yet, this
            page tells you exactly what's missing — "This shipment doesn't have a contract or a
            schedule assigned yet" — rather than letting you send an incomplete request.</P>
        </StepBody>
        <Step n={2}>Send the booking request</Step>
        <StepBody>
          <P>Once a schedule's attached, this page turns into a real form. Click{" "}
            <Tag>Send Booking Request</Tag> to transmit it to the carrier — for the carriers
            CargoDesk can reach directly, this goes out as a real EDI message with its own outbound
            record you can review later.</P>
        </StepBody>
        <Step n={3}>Wait for the carrier's response, then confirm</Step>
        <StepBody>
          <P>The booking sits as <Badge variant="warning">Pending</Badge> until the carrier
            responds. Once they confirm, click <Tag>Confirm</Tag> yourself — this is a deliberate
            second step, so a carrier's confirmed response doesn't silently finalize anything
            without your own review.</P>
        </StepBody>
        <Callout type="note">If you change the carrier on a leg after a booking already exists,
          CargoDesk doesn't edit the old booking in place — it archives it as history and starts a
          fresh one under the new carrier, so you can always see what actually happened.</Callout>
      </div>
    ),
    parties: (
      <div>
        <H2>6. Add Parties & Offices</H2>
        <Dek>A shipment involves more people than just you and the carrier. This chapter is about
          making sure everyone who needs to see it can.</Dek>
        <Step n={1}>The core four</Step>
        <StepBody>
          <P>Open <Tag>Parties & Offices</Tag> and click <Tag>Edit</Tag>. Every shipment has four
            fixed roles worth setting as early as possible: Shipper, Consignee, Notify Party, and
            Principal — each one feeds compliance screening automatically the moment it's saved.</P>
        </StepBody>
        <Step n={2}>Everyone else</Step>
        <StepBody>
          <P>Underneath, <Tag>Additional Parties</Tag> covers forwarders, customs brokers (export
            and import are separate roles, since they're often different companies), truckers, banks,
            insurance providers, and agents — add only the ones this specific shipment actually
            needs.</P>
        </StepBody>
        <Callout type="tip"><strong>Line agents fill themselves in.</strong> If the carrier has a
          registered local agent at your port, CargoDesk assigns it automatically — you'll only ever
          need to set one by hand if there isn't a match on file yet.</Callout>
      </div>
    ),
    customs: (
      <div>
        <H2>7. Handle Customs</H2>
        <Dek>Depending on which side of the shipment you're responsible for, you may need to file
          with customs before cargo can move.</Dek>
        <Step n={1}>Know which filing you need</Step>
        <StepBody>
          <ul style={{ margin: "0 0 10px", paddingLeft: 20 }}>
            <li style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.8 }}><strong>AES/EEI</strong> (export) — needs a <Tag>Customs Broker (Export)</Tag> on the Parties page.</li>
            <li style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.8 }}><strong>ISF/AMS</strong> (import) — needs a <Tag>Customs Broker (Import)</Tag> on the Parties page.</li>
          </ul>
          <P>Both also need priced cargo already on the shipment — another reason Chapter 3 comes
            before this one.</P>
        </StepBody>
        <Step n={2}>Create and submit the filing</Step>
        <StepBody>
          <P>Open <Tag>Customs Filing</Tag>. Whichever side is missing its broker shows a
            greyed-out, disabled Create button with an inline hint explaining exactly what to fix —
            once both preconditions are met, <Tag>Create Filing</Tag> then <Tag>Submit</Tag> moves
            it to Filed.</P>
        </StepBody>
        <Step n={3}>Track the response</Step>
        <StepBody>
          <P>A submitted filing sits as <Tag>Filed</Tag> until a response comes back — Accepted with
            a confirmation number, or Rejected with a reason you can act on and resubmit.</P>
        </StepBody>
      </div>
    ),
    documents: (
      <div>
        <H2>8. Generate Documents</H2>
        <Dek>Everything you've entered so far — cargo, parties, booking, filings — feeds straight
          into the paperwork.</Dek>
        <Step n={1}>Check what's still missing</Step>
        <StepBody>
          <P>Open <Tag>Documents</Tag>. The bar at the top tells you, at a glance, how many of this
            shipment's documents are Confirmed, still in Draft, or entirely Missing.</P>
        </StepBody>
        <Step n={2}>Generate, review, and confirm</Step>
        <StepBody>
          <P>Click <Tag>Generate</Tag> next to any missing document. CargoDesk builds it from the
            shipment's own data, signs it, and saves it as a draft PDF — if something mandatory is
            still missing (a party, a container, a charge line), it tells you exactly what before
            generating anything half-finished. Review the draft, then <Tag>Confirm</Tag> it once
            it's right.</P>
        </StepBody>
      </div>
    ),
    tracking: (
      <div>
        <H2>9. Track the Shipment</H2>
        <Dek>Once the cargo is actually moving, this is where you keep the record honest — logging
          what's really happening as it happens.</Dek>
        <Step n={1}>Log container events</Step>
        <StepBody>
          <P>Each container has its own movement history — Empty Pickup, Gate In, Loaded, Sailed,
            Discharged, Gate Out, Empty Return. Log each stage as it occurs; this is also what
            demurrage and detention tracking is computed from, so keeping it current matters beyond
            just visibility.</P>
        </StepBody>
        <Step n={2}>Work through the milestones</Step>
        <StepBody>
          <P>Open <Tag>Milestones & Events</Tag>. This is the shipment's overall timeline — booking
            confirmed, SI submitted, cargo gated in, vessel departed, and on through delivery. Several
            steps complete themselves automatically as you do the real work elsewhere (confirming a
            booking, logging a Gate In on every container) — you only need to touch the ones that
            don't have an obvious trigger.</P>
        </StepBody>
        <Callout type="note"><strong>Completing things out of order won't block you.</strong> Real
          operations don't always happen in a neat sequence — the milestone stepper is a record of
          what's true, not a gate you have to satisfy in order.</Callout>
      </div>
    ),
    money: (
      <div>
        <H2>10. Handle the Money</H2>
        <Dek>The last piece is making sure what you billed the customer, what the carrier billed
          you, and what you actually agreed to all line up.</Dek>
        <Step n={1}>Cost Entry — what you owe</Step>
        <StepBody>
          <P>Open <Tag>Accounting → Cost Entry</Tag>. This is the buy side — every charge you owe a
            carrier or vendor, one line per charge code.</P>
        </StepBody>
        <Step n={2}>GP Overview — your margin, live</Step>
        <StepBody>
          <P><Tag>Accounting → GP Overview</Tag> puts buy and sell side by side and does the
            subtraction for you — no spreadsheet required.</P>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, margin: "12px 0 14px", maxWidth: 460 }}>
            {[["Est. Buy", "$1,370.00"], ["Est. Sell", "$1,630.00"], ["Margin", "$260 · 16%"]].map(([k, v]) => (
              <div key={k} style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 12px", background: T.surface }}>
                <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>{k}</div>
                <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600 }}>{v}</div>
              </div>
            ))}
          </div>
        </StepBody>
        <Step n={3}>Freight Audit & Payment — trust, but verify</Step>
        <StepBody>
          <P>When the carrier's actual invoice arrives, don't just pay what it says. Open{" "}
            <Tag>Dashboard → Freight Audit</Tag> and enter it — CargoDesk matches every line against
            what was actually accrued or contracted, and independently computes what any detention
            or demurrage charge <em>should</em> be from the container's own free-time fields, before
            ever comparing it to what the carrier billed.</P>
          <P>From here you <Tag>Approve</Tag> a line — which posts it as the real, actualized cost —
            or <Tag>Dispute</Tag> one that's come in wrong: <Badge variant="success">matched</Badge> lines
            need no action, a flagged <Badge variant="danger">variance</Badge> does.</P>
        </StepBody>
        <Callout type="tip"><strong>Detention and demurrage get the same treatment.</strong> If a
          carrier bills you for late container return, the audit already knows your contracted free
          days and checks their math — not just the total.</Callout>
      </div>
    ),
    help: (
      <div>
        <H2>Getting Help</H2>
        <Dek>You've now walked one shipment all the way from a quote to a reconciled invoice. A few
          more things are worth knowing before you're on your own.</Dek>
        <Step n={1}>Ask the AI Assistant</Step>
        <StepBody>
          <P>Click <Tag>AI Assistant</Tag> in the sidebar (or the icon in the top bar from any
            screen). It can look up a specific shipment, list shipments matching criteria, and pull
            contract or allocation details — opened from inside a shipment, it already knows which
            one you mean.</P>
        </StepBody>
        <Step n={2}>Extract data from a document instead of retyping it</Step>
        <StepBody>
          <P>On the <Tag>New Carrier Invoice</Tag> form (Chapter 10), look for{" "}
            <Tag>Extract from document</Tag> — upload the carrier's own PDF or image and it pre-fills
            the form for your review, instead of you typing every line by hand.</P>
        </StepBody>
        <Step n={3}>Where to go from here</Step>
        <StepBody>
          <P>This guide covers the core path end to end, but CargoDesk does more than fits in one
            walkthrough — Master Data (carriers, ports, trade lanes), the Command Center, and the
            Integration Board among them. For a feature-by-feature reference rather than a
            step-by-step story, use the <strong>Reference</strong> section below in this same
            manual — it's organized by topic instead of by sequence, so it's the right place to look
            something up once you already know your way around.</P>
        </StepBody>
        <Callout type="note">🎉 That's the whole lifecycle — quote, shipment, cargo, schedule,
          booking, parties, customs, documents, tracking, and money. Every shipment you touch from
          here follows the same shape.</Callout>
      </div>
    ),
    // ── Reference ────────────────────────────────────────────────────────────
    dashboard: (
      <div>
        <H2>Consumption Dashboard</H2>
        <P>The Dashboard shows TEU consumption against your configured carrier space allocations, scoped to a specific week.</P>
        <H3>Week picker</H3>
        <P>The dashboard always opens on the current week (Monday–Sunday). Use the <strong>← Prev</strong> and <strong>Next →</strong> arrows to navigate between weeks, or click <strong>Today</strong> to return to the current week. Only shipments with an ETD (or creation date) falling in the selected week are counted.</P>
        <H3>KPIs</H3>
        <P><strong>Total Allocated</strong> — the sum of all configured space across all carriers and contract types. <strong>Active Consumption</strong> — TEU booked in the selected week. <strong>Remaining</strong> — how much space is still available.</P>
        <H3>Space Configurations</H3>
        <P>Click <strong>＋ Add Configuration</strong> to set the awarded TEU for a specific carrier and contract type combination — e.g. MAEU / Customer Own = 80 TEU. Edit or remove configurations at any time. The utilisation bar turns amber above 70% and red above 90%.</P>
      </div>
    ),
    "command-center": (
      <div>
        <H2>Command Center</H2>
        <P>The Command Center is an always-dark operational dashboard accessible from the <Tag>✦</Tag> button at the top of the sidebar. It gives a real-time overview of the entire shipment portfolio, active tickets, and AI assistance in a single full-screen view.</P>
        <H3>KPI Cards</H3>
        <P>Six metric cards run across the top: <Tag>Active</Tag>, <Tag>Overdue</Tag>, <Tag>Pending</Tag>, <Tag>Completed</Tag>, <Tag>Total TEU</Tag>, and <Tag>Carriers</Tag>. Click any card to <strong>filter the shipment list</strong> to that category — the list updates in-place without leaving the Command Center. Click the same card again, or the <strong>✕ clear</strong> button next to the section header, to return to the default view (Active + Pending shipments).</P>
        <H3>Shipment List</H3>
        <P>Displays the 10 most recent active/pending shipments by default, with overdue shipments sorted to the top. When a KPI filter is active, up to 50 matching shipments are shown. Click any row to open the <strong>Shipment Preview</strong> panel on the right side.</P>
        <H3>Shipment Preview</H3>
        <P>The preview panel shows the selected shipment's full routing bar — including <Tag>Door</Tag> or <Tag>CY</Tag> pickup/delivery nodes flanking the port-to-port leg when the routing term includes them. The carrier code, ETD, vessel, voyage, routing term, and trade lane appear below the routing diagram. Status, TEU count, and commodity are shown as chips.</P>
        <H3>Integration Board Tickets Card</H3>
        <P>When there are overdue or upcoming tickets on the Integration Board, a <strong>Ticket Alert</strong> card appears between the carrier/route metrics and the shipment list. It has two tabs: <Tag>Overdue</Tag> (tickets past their due date) and <Tag>Due this week</Tag> (tickets with a due date within the next 7 days). Each row shows the ticket's priority colour, title, status, and how many days late or remaining. Click <strong>View board ↗</strong> to navigate directly to the Integration Board (Kanban).</P>
        <H3>AI Agent Panel</H3>
        <P>The right-hand panel (below the Shipment Preview) hosts the AI Agent chat. Type a question or command and press <Tag>Enter</Tag> to send (<Tag>Shift+Enter</Tag> for a newline). The agent can look up individual shipments, list shipments matching criteria, and retrieve contract and allocation details. The AI Agent must be enabled in <strong>App Settings → API Controls → AI Agent</strong>, and requires a valid API key configured there.</P>
        <H3>Carrier and Route Summary</H3>
        <P>Below the KPI cards, two panels summarise the active portfolio by carrier (shipment count and TEU) and by trade lane. These update live as new data arrives via WebSocket.</P>
      </div>
    ),
    "integration-board": (
      <div>
        <H2>Integration Board</H2>
        <P>The Integration Board (<Tag>◩</Tag> in the sidebar) is a Kanban-style tracker for development, QA, and operational tasks, kept separate from shipment records.</P>
        <H3>Tickets</H3>
        <P>Tickets have a <Tag>type</Tag> (Epic, Story, Feature, Bug, Improvement, Task, Chore), a <Tag>priority</Tag>, and a status column. Drag a card between columns to change its status — drop indicators show exactly where it will land. Epics can nest Story and sub-task children; child progress shows as a ring on the Epic card and a breadcrumb chip on children. A ticket can optionally be linked to a shipment.</P>
        <H3>Ticket Links</H3>
        <P>Tickets can be linked to each other from the Links tab in the ticket preview: <Tag>Blocks</Tag>, <Tag>Is blocked by</Tag>, <Tag>Duplicates</Tag>, <Tag>Implements</Tag>.</P>
        <H3>Test Cases</H3>
        <P>Test Plans, Test Runs, and Test Cases live in their own dedicated pages, kept separate from the Integration Board so QA work doesn't clutter the dev ticket board. A Test Case can be linked to a Story via the <Tag>Tests</Tag> / <Tag>Is tested by</Tag> relationship, editable from either side — this gives lightweight requirement-to-test traceability without a full requirements-management module.</P>
      </div>
    ),
    "ai-agent": (
      <div>
        <H2>AI Agent</H2>
        <P>The AI Agent (<Tag>✦</Tag> chat drawer, also embedded in the Command Center) answers questions about shipments, contracts, and allocations using a tool-calling loop against CargoDesk's own API. It must be enabled and configured in <strong>App Settings → API Controls → AI Agent</strong> before it appears anywhere in the app.</P>
        <H3>Provider presets</H3>
        <P>Three presets are available: <Tag>Anthropic</Tag> (Claude models, Messages API), <Tag>OpenRouter</Tag> (any model OpenRouter hosts, OpenAI-compatible Chat Completions API), and <Tag>Custom / Local</Tag> (any OpenAI-compatible endpoint you provide — including a model you run yourself). The backend detects which format to speak from the endpoint URL, so switching presets never needs a code change.</P>
        <H3>Running a model locally (no subscription cost)</H3>
        <P>The <Tag>Custom / Local</Tag> preset works with any locally-hosted, OpenAI-compatible endpoint. Two options that work out of the box:</P>
        <P><strong>Ollama</strong> — if already installed, run <Tag>ollama serve</Tag>, pull a model (e.g. <Tag>ollama pull llama3.1</Tag>), then set the Custom / Local endpoint to <Tag>http://localhost:11434/v1</Tag> in App Settings.</P>
        <P><strong>Hermes Agent</strong> (Nous Research, open-source, MIT-licensed, github.com/NousResearch/hermes-agent) — a self-hosted agent with persistent memory and a built-in skill system, not just a bare chat model. Install natively on Windows with:</P>
        <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, padding: "10px 14px", margin: "0 0 10px" }}>
          <code style={{ fontFamily: T.mono, fontSize: 12.5, color: T.textCode }}>iex (irm https://hermes-agent.nousresearch.com/install.ps1)</code>
        </div>
        <P>On Linux, macOS, WSL2, or Termux, use the bash installer instead:</P>
        <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, padding: "10px 14px", margin: "0 0 10px" }}>
          <code style={{ fontFamily: T.mono, fontSize: 12.5, color: T.textCode }}>curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash</code>
        </div>
        <P>The Windows installer is user-scoped (installs under <Tag>%LOCALAPPDATA%\hermes</Tag> — portable Python, Node, and Git) and needs no admin rights; it only creates an autostart entry if you explicitly pass <Tag>-IncludeDesktop</Tag>. Review any installer script before running it, same as you would for any third-party software.</P>
        <P>Once running, point the <Tag>Custom / Local</Tag> endpoint at whatever base URL Hermes Agent's gateway exposes on your machine, save, and use <strong>Test Connection</strong> in App Settings to confirm CargoDesk can reach it before enabling the feature for other users.</P>
        <H3>Context awareness</H3>
        <P>When the chat is opened from a shipment's detail page, its ID is passed as context automatically, so you can ask things like "what's the status of this shipment" without repeating the ID.</P>
      </div>
    ),
    "freight-basics": (
      <div>
        <H2>Ocean Freight Basics</H2>
        <P>New to shipping, or just want the vocabulary straight? This page covers the handful of
          concepts that show up constantly in ocean freight — how cargo physically moves, and what
          the two kinds of Bill of Lading actually are and who issues each. It's general shipping
          knowledge, not a CargoDesk feature guide, but it explains exactly what CargoDesk is doing
          for you at each step.</P>

        <H3>How cargo moves: containers vs. Ro-Ro</H3>
        <P>Almost all ocean cargo travels one of two ways. <strong>Lift-on/Lift-off (Lo-Lo)</strong>{" "}
          is what CargoDesk is built around: cargo is packed into a standard steel container, and a
          crane lifts that container on and off the vessel. This is what "FCL" (Full Container Load)
          and the 20'/40' container sizes throughout CargoDesk refer to.</P>
        <P><strong>Roll-on/Roll-off (Ro-Ro)</strong> is a different method entirely, used for cars,
          trucks, trailers, and other wheeled or self-propelled cargo — instead of being craned, it's
          driven or towed directly on and off the vessel via ramps at the bow, stern, or side. A Ro-Ro
          vessel has no container cranes at all; capacity is measured in vehicle lanes, not TEU.
          <strong> CargoDesk does not currently model Ro-Ro bookings</strong> — every shipment here
          assumes containerized (Lo-Lo) cargo — but it's worth knowing the term, since a carrier or
          port you work with may run both kinds of vessel.</P>

        <H3>Master Bill of Lading vs. House Bill of Lading</H3>
        <P>A Bill of Lading (B/L) is three things at once: a receipt for the cargo, evidence of the
          contract of carriage, and (unless marked non-negotiable) a document of title — whoever holds
          the original can claim the goods. Where things get confusing is that a single shipment often
          has <strong>two</strong> of them, issued by two different parties.</P>
        <P><strong>Master Bill of Lading (MBL)</strong> — issued by the actual vessel-operating
          carrier (the shipping line, e.g. Maersk or CMA CGM) to whoever booked the container space
          with them. On a shipment routed through a freight forwarder or NVOCC, that "whoever" is the
          forwarder/NVOCC itself, not your customer — the carrier only ever contracts with the party
          it directly booked with.</P>
        <P><strong>House Bill of Lading (HBL)</strong> — issued by the freight forwarder or NVOCC to
          its own actual customer (the real shipper and consignee). This is the document your customer
          sees and uses to claim their cargo at destination; they typically never see the Master B/L
          at all.</P>
        <H3>How they interlink</H3>
        <P>The forwarder/NVOCC sits in the middle of both contracts at once — it's the{" "}
          <strong>consignee</strong> named on the Master B/L (the carrier's customer), and the{" "}
          <strong>carrier</strong> named on the House B/L (its own customer's counterparty). Both
          documents describe the same physical container moving on the same vessel, cross-referenced
          by each other's B/L number, but they're legally two separate contracts of carriage covering
          two different legs of the same relationship — carrier-to-forwarder, and forwarder-to-shipper.</P>
        <P>CargoDesk builds this directly: every shipment gets a <Tag>BL01</Tag> House Bill of Lading
          (from CargoDesk's operator to the shipment's own Shipper/Consignee). If you assign an{" "}
          <strong>NVOCC</strong> party on the Parties & Offices page, a second, independent{" "}
          <Tag>MB01</Tag> Master Bill of Lading also becomes available — shipper is the assigned NVOCC,
          consignee reads <em>"TO ORDER OF {"{NVOCC}"}"</em>, and each document's generated HTML
          cross-references the other's B/L number, exactly matching how the two are used in practice.</P>

        <H3>Who's who on a shipment</H3>
        <P><Tag>Shipper</Tag> the party sending the goods · <Tag>Consignee</Tag> the party receiving
          them · <Tag>Notify Party</Tag> who the carrier alerts on arrival, often the same as the
          consignee · <Tag>Principal</Tag> CargoDesk's own commercial customer of record for the
          shipment · <Tag>NVOCC</Tag> a Non-Vessel Operating Common Carrier — acts as a carrier to its
          own customer while being a shipper to the real vessel operator, exactly the dual role
          described above. Assign any of these from a shipment's Parties & Offices page.</P>

        <div style={{ marginTop: 16, padding: "12px 16px", background: T.bg,
          border: `1px solid ${T.border}`, borderRadius: 8 }}>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.7 }}>
            📋 <strong style={{ color: T.text }}>Further reading:</strong> for a deeper dive with
            worked examples, see{" "}
            <a href="https://docshipper.com/shipping/bill-lading-complete-guide/" target="_blank" rel="noreferrer"
              style={{ color: T.accent }}>DocShipper's Bill of Lading guide</a>{" "}
            and{" "}
            <a href="https://www.hoeghautoliners.com/news/what-is-roro-shipping" target="_blank" rel="noreferrer"
              style={{ color: T.accent }}>Höegh Autoliners on Ro-Ro shipping</a>.
          </div>
        </div>
      </div>
    ),
    mdm: (
      <div>
        <H2>Master Data Management (MDM)</H2>
        <P>MDM is the reference layer for all operational data. Changes here propagate automatically to shipment forms and the dashboard.</P>
        <H3>Carriers</H3>
        <P>Add, edit, or remove ocean carriers. Each carrier requires a SCAC code (e.g. <Tag>MAEU</Tag>) and a full name. Carriers listed here appear in the shipment carrier dropdown.</P>
        <H3>Port Locations</H3>
        <P>The port database contains 14,000+ UN/LOCODE records with coordinates. Use the search bar to filter by code or name. Every row with coordinates includes a <strong>📍 Map</strong> link that opens Google Maps at that location. You can add custom ports or edit existing ones.</P>
        <H3>Linked Ports</H3>
        <P>Create links between ports that share a geographical area (e.g. <Tag>USLAX</Tag> → <Tag>USLGB</Tag>). Useful for matching booking data where the same physical port appears under multiple codes.</P>
        <H3>Trade Lanes</H3>
        <P>14 FIATA high-level trade lanes are pre-configured (<Tag>FE</Tag>, <Tag>EU-N</Tag>, <Tag>ME</Tag>, etc.). Each lane lists its assigned countries. Use the edit modal to search for countries by name or ISO2 code and add or remove them from the lane.</P>
        <H3>Countries</H3>
        <P>ISO 3166-1 alpha-2 country registry pre-populated with 193 UN member states and key territories. Each country shows its assigned trade lanes and seaport count. Click <strong>View Locations</strong> to see all UN/LOCODE ports for that country.</P>
        <H3>UN Location Codes</H3>
        <P>A complete index of all 5-character codes in the system. The <strong>Has Seaport?</strong> column shows ✅ for any code that matches a port in the Port Locations database, and <Tag>—</Tag> for codes referenced in shipments but not yet in the master data.</P>
      </div>
    ),
    incoterms: (
      <div>
        <H2>Incoterms® 2020</H2>
        <P>Incoterms® are standardised trade terms published by the ICC, used in every international shipment to define where risk and cost transfer from seller to buyer.</P>
        <button onClick={() => setShowIncoterms(true)} style={{
          display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 20,
          padding: "9px 18px", borderRadius: 7, cursor: "pointer",
          background: T.accentBg, border: `1px solid ${T.accent}55`,
          color: T.accent, fontFamily: T.body, fontSize: 13, fontWeight: 600,
        }}>
          📋 Open Incoterm Information
        </button>
        <H3>The two groups</H3>
        <P><strong>Any transport mode</strong> (EXW, FCA, CPT, CIP, DAP, DPU, DDP) — suitable for all cargo types including containerised ocean freight.</P>
        <P><strong>Sea and inland waterway only</strong> (FAS, FOB, CFR, CIF) — intended for bulk and break-bulk. For containerised cargo, prefer FCA over FOB and CIP over CIF.</P>
        <H3>Key principle</H3>
        <P>Incoterms define where <em>risk</em> and <em>cost</em> transfer from seller to buyer. They do not determine title of goods, payment terms, or liability for cargo damage beyond the risk transfer point.</P>
        {showIncoterms && <IncotermsModal onClose={() => setShowIncoterms(false)} />}
      </div>
    ),
        "dg-classes": (
      <div>
        <H2>IMDG Dangerous Goods Classes</H2>
        <P>The International Maritime Dangerous Goods (IMDG) Code classifies hazardous materials into 9 primary classes. When a container is flagged as DG in CargoDesk, the applicable class is mandatory. This ensures correct handling, segregation, and documentation across the shipment lifecycle.</P>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {IMDG_CLASSES.reduce((acc, c) => {
            const last = acc[acc.length - 1];
            if (!last || last.classNum !== c.classNum) acc.push({ classNum: c.classNum, entries: [c] });
            else last.entries.push(c);
            return acc;
          }, []).map(({ classNum, entries }) => {
            const variant = IMDG_CLASS_VARIANT[classNum] || "default";
            const borderCol = variant === "danger" ? T.danger : variant === "warning" ? T.warning : T.border;
            return (
              <div key={classNum} style={{ background: T.surface, border: `1px solid ${T.border}`,
                borderLeft: `4px solid ${borderCol}`, borderRadius: 10, overflow: "hidden" }}>
                <div style={{ padding: "10px 16px", background: T.bg, borderBottom: `1px solid ${T.border}44`,
                  display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: borderCol,
                    background: `${borderCol}22`, border: `1px solid ${borderCol}44`,
                    borderRadius: 5, padding: "2px 10px" }}>Class {classNum}</span>
                  <span style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text }}>
                    {entries[0].name.replace(/Subclass \d+\.?\d* — /, "").split(" — ")[0]}
                  </span>
                </div>
                {entries.map((c, i) => (
                  <div key={c.code} style={{ padding: "10px 16px",
                    borderBottom: i < entries.length - 1 ? `1px solid ${T.border}22` : "none",
                    display: "grid", gridTemplateColumns: "110px 1fr", gap: 12 }}>
                    <div>
                      <div style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: borderCol }}>{c.label}</div>
                    </div>
                    <div>
                      <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600, marginBottom: 3 }}>
                        {c.name.includes(" — ") ? c.name.split(" — ")[1] : c.name}
                      </div>
                      <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.6 }}>
                        {c.description}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 16, padding: "12px 16px", background: T.bg,
          border: `1px solid ${T.border}`, borderRadius: 8 }}>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.7 }}>
            📋 <strong style={{ color: T.text }}>Documentation note:</strong> DG shipments require
            a Dangerous Goods Declaration (DGD). The container must be marked and placarded with the
            appropriate IMDG hazard label. Always verify compliance with the carrier's DG acceptance
            policy and port restrictions before booking. Source:{" "}
            <a href="https://www.searates.com/reference/imo/" target="_blank" rel="noreferrer"
              style={{ color: T.accent }}>SeaRates IMO Reference</a>.
          </div>
        </div>
      </div>
    ),
  };

  return (
    <div style={{ display: "flex", gap: 28 }}>
      {/* Sidebar TOC */}
      <div style={{ width: 200, flexShrink: 0 }}>
        <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.textMuted, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: ".1em", padding: "0 14px 8px" }}>Walkthrough</div>
        {WALKTHROUGH.map(s => <SectionBtn key={s.id} id={s.id} label={s.label} />)}
        <GroupLabel>Reference</GroupLabel>
        {REFERENCE.map(s => <SectionBtn key={s.id} id={s.id} label={s.label} />)}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {content[section]}
      </div>
    </div>
  );
};

export default UserManualPage;
