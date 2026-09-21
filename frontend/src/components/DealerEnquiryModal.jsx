import { useState } from "react";
import { INDIA_STATES } from "../data/dentallData";

const MIN_QTY = 100;
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

const EMPTY = {
  name: '', shop: '', gstin: '', email: '', phone: '',
  address: '', city: '', state: '', pincode: '', quantity: '', message: '',
};

/* ─── RETAIL DEALER ENQUIRY FORM ───────────────────────────────── */
export default function DealerEnquiryModal({ onClose }) {
  const [form, setForm]             = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted]   = useState(false);
  const [error, setError]           = useState('');

  const set = (key, transform = v => v) => e =>
    setForm(f => ({ ...f, [key]: transform(e.target.value) }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!GSTIN_RE.test(form.gstin)) { setError('Enter a valid 15-character GSTIN, e.g. 33AABCU9603R1ZM.'); return; }
    if (Number(form.quantity) < MIN_QTY) { setError(`Minimum dealer quantity is ${MIN_QTY} units.`); return; }

    setSubmitting(true);
    try {
      const res  = await fetch('/api/dealer-enquiries', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...form, quantity: Number(form.quantity) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not submit your enquiry. Please try again.');
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof TypeError ? 'Network error. Please check your connection and try again.' : err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="dn-wholesale-modal" onClick={onClose}>
      <div className="dn-wholesale-backdrop" />
      <div className="dn-wholesale-box" onClick={e => e.stopPropagation()}>
        <div className="dn-wholesale-header">
          <div>
            <h2>Retail Dealer Enquiry</h2>
            <p>Tell us what you need — we'll send you a custom price quote within 24 hours</p>
          </div>
          <button className="dn-wholesale-close" onClick={onClose} aria-label="Close dealer enquiry">x</button>
        </div>

        {submitted ? (
          <div className="dn-wholesale-success">
            <div className="dn-wholesale-success-icon">✓</div>
            <h3>Enquiry Received!</h3>
            <p>Thank you. We've emailed you a confirmation. Our team will review your requirement and send your price quote by email within 24 hours.</p>
          </div>
        ) : (
          <form className="dn-wholesale-body" onSubmit={submit}>
            <div className="dn-wholesale-grid">
              <div className="dn-wholesale-field">
                <label>Contact Person *</label>
                <input required type="text" placeholder="Your name" value={form.name} onChange={set('name')} />
              </div>
              <div className="dn-wholesale-field">
                <label>Shop / Business Name *</label>
                <input required type="text" placeholder="Your shop name" value={form.shop} onChange={set('shop')} />
              </div>
              <div className="dn-wholesale-field">
                <label>GSTIN *</label>
                <input required type="text" placeholder="33AABCU9603R1ZM" maxLength={15}
                  value={form.gstin} onChange={set('gstin', v => v.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                  title="15-character GST number" />
              </div>
              <div className="dn-wholesale-field">
                <label>Quantity (units) *</label>
                <input required type="number" min={MIN_QTY} step="1" placeholder={`Minimum ${MIN_QTY}`}
                  value={form.quantity} onChange={set('quantity')} />
              </div>
              <div className="dn-wholesale-field">
                <label>Email Address *</label>
                <input required type="email" placeholder="you@example.com" value={form.email} onChange={set('email')} />
              </div>
              <div className="dn-wholesale-field">
                <label>Phone Number *</label>
                <input required type="tel" placeholder="9876543210" maxLength={10}
                  value={form.phone} onChange={set('phone', v => v.replace(/\D/g, '').slice(0, 10))}
                  pattern="[6-9][0-9]{9}" title="Enter a valid 10-digit Indian mobile number" />
              </div>
              <div className="dn-wholesale-field full">
                <label>Shop Address *</label>
                <input required type="text" placeholder="Shop no., street, area" value={form.address} onChange={set('address')} />
              </div>
              <div className="dn-wholesale-field">
                <label>City *</label>
                <input required type="text" placeholder="City" value={form.city} onChange={set('city')} />
              </div>
              <div className="dn-wholesale-field">
                <label>State *</label>
                <select required value={form.state} onChange={set('state')}>
                  <option value="">Select state</option>
                  {INDIA_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="dn-wholesale-field">
                <label>Delivery Pincode *</label>
                <input required type="text" inputMode="numeric" placeholder="600001" maxLength={6}
                  value={form.pincode} onChange={set('pincode', v => v.replace(/\D/g, '').slice(0, 6))}
                  pattern="[0-9]{6}" title="6-digit pincode" />
              </div>
              <div className="dn-wholesale-field full">
                <label>Additional Message</label>
                <textarea placeholder="Delivery timeline, branding needs, anything else we should know…"
                  value={form.message} onChange={set('message')} />
              </div>
            </div>
            {error && <div className="dn-wholesale-error">{error}</div>}
            <button type="submit" className="dn-wholesale-submit" disabled={submitting}>
              {submitting ? 'Submitting...' : 'Request Dealer Quote ->'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
