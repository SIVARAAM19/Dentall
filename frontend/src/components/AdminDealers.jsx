import { useCallback, useEffect, useState } from "react";

const inr = n => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const round2 = n => Math.round(n * 100) / 100;

// Preview only — the server recomputes everything and is the source of truth
function previewQuote({ quantity, unitPrice, gstPercent, freight, advancePercent }) {
  const q  = Number(quantity) || 0;
  const g  = round2((Number(unitPrice) || 0) * q);
  const gst = round2(g * (Number(gstPercent) || 0) / 100);
  const total = round2(g + gst + (Number(freight) || 0));
  const advance = round2(total * (Number(advancePercent) || 0) / 100);
  return { goods: g, gst, total, advance, balance: round2(total - advance) };
}

function QuoteForm({ enquiry, token, onCreated }) {
  const [f, setF] = useState({
    quantity: enquiry.quantity, unitPrice: '', gstPercent: 0, freight: 0,
    advancePercent: 0, validDays: 7, notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState(null);
  const set = key => e => setF(x => ({ ...x, [key]: e.target.value }));
  const p = previewQuote(f);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setMsg(null);
    try {
      const res  = await fetch('/api/admin/dealer-quotes', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
        body:    JSON.stringify({
          enquiryId: enquiry.id,
          quantity: Number(f.quantity), unitPrice: Number(f.unitPrice),
          gstPercent: Number(f.gstPercent), freight: Number(f.freight),
          advancePercent: Number(f.advancePercent), validDays: Number(f.validDays), notes: f.notes,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not create the quote.');
      setMsg({ type: 'ok', text: data.emailed
        ? `Quote created and emailed to ${enquiry.email}.`
        : 'Quote created, but the email could not be sent — copy the link below and send it yourself.' });
      onCreated();
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="dn-dealer-quote-form">
      <div className="dn-admin-row">
        <label>Quantity (units)
          <input className="dn-admin-input" type="number" min="1" required value={f.quantity} onChange={set('quantity')} />
        </label>
        <label>Price per unit (₹) for this dealer
          <input className="dn-admin-input" type="number" min="0.01" step="0.01" required placeholder="e.g. 480"
            value={f.unitPrice} onChange={set('unitPrice')} />
        </label>
      </div>
      <div className="dn-admin-row">
        <label>GST % added on goods (0 = none)
          <input className="dn-admin-input" type="number" min="0" max="28" step="0.01" value={f.gstPercent} onChange={set('gstPercent')} />
        </label>
        <label>Freight (₹, 0 = included)
          <input className="dn-admin-input" type="number" min="0" step="0.01" value={f.freight} onChange={set('freight')} />
        </label>
      </div>
      <div className="dn-admin-row">
        <label>Advance % (0 = full cash on delivery)
          <input className="dn-admin-input" type="number" min="0" max="100" step="0.01" value={f.advancePercent} onChange={set('advancePercent')} />
        </label>
        <label>Quote valid for (days)
          <input className="dn-admin-input" type="number" min="1" max="60" value={f.validDays} onChange={set('validDays')} />
        </label>
      </div>
      <label style={{ display: 'block' }}>Notes for the dealer (optional)
        <textarea className="dn-admin-input" rows={2} maxLength={1000} value={f.notes} onChange={set('notes')}
          placeholder="Delivery timeline, packing, branding…" />
      </label>

      {Number(f.unitPrice) > 0 && (
        <div className="dn-admin-preview">
          {f.quantity} × {inr(f.unitPrice)} = {inr(p.goods)} · GST {inr(p.gst)} · <strong>Total {inr(p.total)}</strong>
          {Number(f.advancePercent) > 0
            ? ` · advance ${inr(p.advance)}, balance on delivery ${inr(p.balance)}`
            : ' · cash on delivery'}
        </div>
      )}

      <button className="dn-admin-btn" type="submit" disabled={saving}>
        {saving ? 'Creating…' : 'Create quote & email dealer'}
      </button>
      {msg && <div className={msg.type === 'ok' ? 'dn-admin-success' : 'dn-admin-error'}>{msg.text}</div>}
    </form>
  );
}

function EnquiryCard({ e, token, reload }) {
  const [open, setOpen]     = useState(false);
  const [copied, setCopied] = useState('');

  const call = async (url, body) => {
    await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
      body:    body ? JSON.stringify(body) : undefined,
    });
    reload();
  };

  const copy = async (link) => {
    try { await navigator.clipboard.writeText(link); setCopied(link); setTimeout(() => setCopied(''), 2000); }
    catch { window.prompt('Copy this link:', link); }
  };

  return (
    <div className="dn-dealer-card">
      <div className="dn-dealer-head">
        <div>
          <div className="dn-dealer-shop">{e.shop_name} <span className={`dn-dealer-status ${e.status}`}>{e.status}</span></div>
          <div className="dn-dealer-meta">
            #{e.id} · {e.contact_name} · {e.phone} · {e.email}<br />
            GSTIN {e.gstin} · {e.address}, {e.city}, {e.state} {e.pincode}<br />
            Wants <strong>{e.quantity}</strong> units · {new Date(e.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
          </div>
          {e.message && <div className="dn-dealer-msg">“{e.message}”</div>}
        </div>
        <div className="dn-dealer-actions">
          <button className="dn-admin-btn" style={{ marginTop: 0 }} onClick={() => setOpen(o => !o)}>
            {open ? 'Hide quote form' : 'Create quote'}
          </button>
          {e.status !== 'closed'
            ? <button className="dn-admin-logout" onClick={() => call(`/api/admin/dealer-enquiries/${e.id}/status`, { status: 'closed' })}>Close</button>
            : <button className="dn-admin-logout" onClick={() => call(`/api/admin/dealer-enquiries/${e.id}/status`, { status: e.quotes.length ? 'quoted' : 'new' })}>Reopen</button>}
        </div>
      </div>

      {open && <QuoteForm enquiry={e} token={token} onCreated={reload} />}

      {e.quotes.length > 0 && (
        <div className="dn-dealer-quotes">
          {e.quotes.map(q => (
            <div key={q.id} className="dn-dealer-quote-row">
              <div>
                <strong>{q.quantity} units · {inr(q.total)}</strong>
                <span className={`dn-dealer-status ${q.status}`}>{q.status}</span>
                <div className="dn-dealer-meta">
                  {q.advancePercent > 0 ? `${q.advancePercent}% advance` : 'Full COD'} · valid until {q.validUntil}
                </div>
              </div>
              <div className="dn-dealer-actions">
                <button className="dn-admin-logout" onClick={() => copy(q.link)}>{copied === q.link ? 'Copied ✓' : 'Copy link'}</button>
                <a className="dn-admin-logout" href={q.link} target="_blank" rel="noopener noreferrer">Open</a>
                {q.status !== 'cancelled' && (
                  <button className="dn-admin-logout" onClick={() => { if (window.confirm('Cancel this quote? Its link will stop working.')) call(`/api/admin/dealer-quotes/${q.id}/cancel`); }}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── ADMIN: DEALER ENQUIRIES & QUOTES ─────────────────────────── */
export default function AdminDealers({ token }) {
  const [list, setList]       = useState(null);
  const [error, setError]     = useState('');
  const [filter, setFilter]   = useState('open');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/dealer-enquiries', { headers: { 'x-admin-token': token } });
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error(data.error || 'Could not load dealer enquiries.');
      setList(data); setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const shown = (list || []).filter(e => filter === 'all' ? true : filter === 'open' ? e.status !== 'closed' : e.status === filter);

  return (
    <div className="dn-admin-card dn-admin-card-wide dn-admin-card-xl">
      <div className="dn-admin-header">
        <h1 className="dn-admin-title">Dealer enquiries</h1>
        <button className="dn-admin-logout" onClick={load}>Refresh</button>
      </div>
      <p className="dn-admin-sub">
        Dealers submit the form on the site. Create a custom-priced quote here — the dealer gets an email with a private link to it.
      </p>

      <div className="dn-dealer-filters">
        {['open', 'new', 'quoted', 'closed', 'all'].map(k => (
          <button key={k} className={`dn-admin-logout ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>{k}</button>
        ))}
      </div>

      {error && <div className="dn-admin-error">{error}</div>}
      {list === null && !error && <p>Loading…</p>}
      {list && shown.length === 0 && <p>No dealer enquiries here yet.</p>}
      {shown.map(e => <EnquiryCard key={e.id} e={e} token={token} reload={load} />)}
    </div>
  );
}
