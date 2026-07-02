import { T } from "../tokens";
import { COPYRIGHT_YEAR, COPYRIGHT_OWNER } from "../version";

// ─── License Page ─────────────────────────────────────────────────────────────

const Section = ({ title, children }) => (
  <div style={{ marginBottom: 32 }}>
    <h2 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text,
      margin: "0 0 10px", paddingBottom: 8, borderBottom: `1px solid ${T.border}` }}>
      {title}
    </h2>
    <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, lineHeight: 1.75 }}>
      {children}
    </div>
  </div>
);

const P = ({ children }) => <p style={{ margin: "0 0 10px" }}>{children}</p>;

const Ol = ({ items }) => (
  <ol style={{ margin: "0 0 10px", paddingLeft: 22 }}>
    {items.map((it, i) => <li key={i} style={{ marginBottom: 6 }}>{it}</li>)}
  </ol>
);

const EFFECTIVE_DATE = "1 July 2026";

const LicensePage = () => (
  <div style={{ maxWidth: 820, margin: "0 auto", padding: "32px 24px 80px" }}>

    {/* Header */}
    <div style={{ marginBottom: 36 }}>
      <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: "0 0 6px" }}>
        End-User License Agreement
      </h1>
      <p style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted, margin: 0 }}>
        CargoDesk · Effective {EFFECTIVE_DATE} · © {COPYRIGHT_YEAR} {COPYRIGHT_OWNER}
      </p>
    </div>

    {/* Highlight box */}
    <div style={{ background: T.warning + "18", border: `1px solid ${T.warning}55`,
      borderRadius: 8, padding: "14px 18px", marginBottom: 32,
      fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.6 }}>
      <strong>Summary (not a substitute for the full agreement below):</strong> CargoDesk is free
      for personal and internal non-commercial use. Commercial use — including deploying it for
      a business, offering it as a service, or integrating it into a commercial product — requires
      a separate written licence from the author. Unauthorised commercial use is a breach of this
      agreement.
    </div>

    <Section title="1. Definitions">
      <P>"Software" means the CargoDesk application, including all source code, binaries,
        documentation, and associated files.</P>
      <P>"Author" means {COPYRIGHT_OWNER}, the original creator and copyright holder of the Software.</P>
      <P>"You" means the individual or entity installing, accessing, or using the Software.</P>
      <P>"Non-Commercial Use" means use that is not primarily intended for, or directed towards,
        commercial advantage or monetary compensation. Examples include personal projects, academic
        research, internal evaluation, and open-source contributions.</P>
      <P>"Commercial Use" means any use intended to generate revenue, including but not limited to:
        deployment within a for-profit organisation's operations, offering the Software as a
        service (SaaS), embedding it in a commercial product, or using it to support billable
        client work.</P>
    </Section>

    <Section title="2. Grant of Licence">
      <P>Subject to the terms of this Agreement, the Author grants You a limited, non-exclusive,
        non-transferable, revocable licence to install and use the Software solely for
        Non-Commercial Use.</P>
      <P>This licence does not grant You any rights to the Software's source code beyond what is
        explicitly permitted by this Agreement, and does not confer any ownership interest in the
        Software.</P>
    </Section>

    <Section title="3. Restrictions">
      <P>You may not, without prior written permission from the Author:</P>
      <Ol items={[
        "Use the Software for any Commercial Use.",
        "Sell, sublicense, rent, lease, or otherwise transfer the Software or any rights therein to any third party.",
        "Remove, alter, or obscure any proprietary notices, labels, or marks on the Software.",
        "Represent the Software as your own product or creation.",
        "Use the Software in any manner that violates applicable laws or regulations.",
        "Deploy the Software as part of a managed service offering without a commercial licence.",
      ]} />
    </Section>

    <Section title="4. Commercial Licensing">
      <P>If You wish to use the Software for Commercial Use, You must obtain a separate commercial
        licence from the Author prior to such use. Commercial licences are available on terms to
        be agreed in writing.</P>
      <P>To enquire about commercial licensing, contact the Author at the address provided on the
        project's repository or official website. Use without a commercial licence constitutes
        copyright infringement and a material breach of this Agreement.</P>
    </Section>

    <Section title="5. Intellectual Property">
      <P>The Software is protected by copyright law. The Author retains all intellectual property
        rights in and to the Software. Nothing in this Agreement transfers any ownership of
        intellectual property rights to You.</P>
    </Section>

    <Section title="6. Disclaimer of Warranties">
      <P style={{ textTransform: "uppercase", fontWeight: 600 }}>
        The Software is provided "as is", without warranty of any kind, express or implied,
        including but not limited to the warranties of merchantability, fitness for a particular
        purpose, accuracy, or non-infringement. The Author makes no warranty that the Software
        will meet your requirements or operate without interruption or error.
      </P>
    </Section>

    <Section title="7. Limitation of Liability">
      <P>To the fullest extent permitted by applicable law, in no event shall the Author be liable
        for any indirect, incidental, special, consequential, or exemplary damages — including
        loss of profit, data, or business opportunity — arising out of or in connection with your
        use of or inability to use the Software, even if the Author has been advised of the
        possibility of such damages.</P>
      <P>The Author's total aggregate liability under this Agreement shall not exceed the amount
        paid by You to the Author in the twelve months preceding the claim (if any).</P>
    </Section>

    <Section title="8. Termination">
      <P>This licence is effective until terminated. It will terminate automatically, without
        notice, if You fail to comply with any term of this Agreement. Upon termination You must
        cease all use of the Software and destroy all copies in your possession.</P>
      <P>The Author may also terminate this licence at any time by providing thirty (30) days'
        written notice.</P>
    </Section>

    <Section title="9. Governing Law">
      <P>This Agreement shall be governed by and construed in accordance with applicable law.
        Any disputes arising under this Agreement shall be subject to the exclusive jurisdiction
        of the courts of the Author's place of residence or principal business.</P>
    </Section>

    <Section title="10. Entire Agreement">
      <P>This Agreement constitutes the entire agreement between You and the Author with respect
        to the Software and supersedes all prior understandings, representations, and agreements.
        Any amendment must be in writing and signed by the Author.</P>
    </Section>

    {/* Donation section */}
    <div style={{ background: T.surface, border: `1px solid ${T.border}`,
      borderRadius: 10, padding: "24px 28px", marginTop: 8 }}>
      <h2 style={{ fontFamily: T.head, fontSize: 16, fontWeight: 700, color: T.text, margin: "0 0 10px" }}>
        ☕ Support CargoDesk
      </h2>
      <p style={{ fontFamily: T.body, fontSize: 13.5, color: T.text, lineHeight: 1.7, margin: "0 0 16px" }}>
        CargoDesk is free for non-commercial use. If it saves you time or you find it useful,
        consider supporting its development. Even a small contribution helps cover the AI tooling
        costs (Anthropic API) that power the features you rely on.
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <a href="https://ko-fi.com" target="_blank" rel="noopener noreferrer"
          style={{ display: "inline-flex", alignItems: "center", gap: 8,
            fontFamily: T.body, fontSize: 13, fontWeight: 600, textDecoration: "none",
            background: "#FF5E5B", color: "#fff",
            borderRadius: 7, padding: "9px 18px", transition: "opacity .15s" }}
          onMouseEnter={e => e.currentTarget.style.opacity = "0.85"}
          onMouseLeave={e => e.currentTarget.style.opacity = "1"}>
          ☕ Buy me a coffee (Ko-fi)
        </a>
        <a href="https://github.com/sponsors" target="_blank" rel="noopener noreferrer"
          style={{ display: "inline-flex", alignItems: "center", gap: 8,
            fontFamily: T.body, fontSize: 13, fontWeight: 600, textDecoration: "none",
            background: T.surface, color: T.text,
            border: `1px solid ${T.border}`,
            borderRadius: 7, padding: "9px 18px", transition: "border-color .15s" }}
          onMouseEnter={e => e.currentTarget.style.borderColor = T.accent}
          onMouseLeave={e => e.currentTarget.style.borderColor = T.border}>
          ♥ GitHub Sponsors
        </a>
      </div>
      <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: "14px 0 0" }}>
        Donations are voluntary and do not grant any additional licence rights. For commercial
        licensing enquiries, contact the Author directly.
      </p>
    </div>

  </div>
);

export default LicensePage;
