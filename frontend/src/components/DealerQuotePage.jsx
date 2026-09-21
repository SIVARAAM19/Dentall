import { useEffect, useState } from "react";

const inr = n => `₹${Number(n).toLocaleString('en-IN')}`;

/* ─── PRIVATE DEALER QUOTE PAGE  (/dealer-quote/<token>) ───────── */
export default function DealerQuotePage() {
  const token = window.location.pathname.split('/').filter(Boolean)[1] || '';
  const [state, setState] = useState({ loading: true, error: '', data: null });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/dealer-quote/${encodeURIComponent(token)}`)
      .then(async res => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Could not load this quote.');
        return body;
      })
      .then(data  => { if (!cancelled) setState({ loading: false, error: '', data }); })
      .catch(err  => { if (!cancelled) setState({ loading: false, error: err.message, data: null }); });
    return () => { cancelled = true; };
  }, [token]);

  const { loading, error, data } = state;
  const q = data?.quote;
  const expired = q?.status === 'expired';

  return (
    <div className="dn-dq-page">
      <div className="dn-dq-card">
        <div className="dn-dq-brand">DENTALL<sup>®</sup> <span>Dealers</span></div>

        {loading && <p className="dn-dq-muted">Loading your quote…</p>}
        {error && <div className="dn-dq-alert">{error}</div>}

        {q && (
          <>
            <h1 className="dn-dq-title">Price quote</h1>
            <p className="dn-dq-muted">
              Prepared for <strong>{data.shopName}</strong> · {data.contactName} · {data.city}, {data.state}
            </p>

            {expired && (
              <div className="dn-dq-alert">This quote expired on {q.validUntil}. Please contact us for a new one.</div>
            )}

            <table className="dn-dq-table">
              <tbody>
                <tr><td>Quantity</td><td>{q.quantity.toLocaleString('en-IN')} units</td></tr>
                <tr><td>Price per unit</td><td>{inr(q.unitPrice)}</td></tr>
                <tr><td>Goods total</td><td>{inr(q.goodsTotal)}</td></tr>
                {q.gstPercent > 0 && <tr><td>GST ({q.gstPercent}%)</td><td>{inr(q.gstAmount)}</td></tr>}
                <tr><td>Freight</td><td>{q.freight > 0 ? inr(q.freight) : 'Included / as agreed'}</td></tr>
                <tr className="dn-dq-total"><td>Total</td><td>{inr(q.total)}</td></tr>
              </tbody>
            </table>

            <div className="dn-dq-box">
              <div><span>Payment</span>{data.paymentTerms}</div>
              <div><span>Valid until</span>{q.validUntil}</div>
              {q.notes && <div><span>Notes</span>{q.notes}</div>}
            </div>

            {!expired && (
              <p className="dn-dq-muted">
                To confirm this order, reply to the email we sent you or write to{' '}
                <a href="mailto:support@dentall.in">support@dentall.in</a>. This link is private — please don't share it.
              </p>
            )}
          </>
        )}

        <a className="dn-dq-home" href="/">← Back to dentall.in</a>
      </div>
    </div>
  );
}
