import React, { useEffect, useState } from "react";

/* ─── SHIPMENT DETAILS PAGE ───────────────────────────────────── */
const STATUS_STEPS = ['Ordered', 'Picked up', 'In transit', 'Out for delivery', 'Delivered'];

// Map a courier status string to a progress step. Couriers use many wordings
// ("PICKED UP", "REACHED AT DESTINATION HUB"…), so match on keywords.
function stepForStatus(status) {
  const s = String(status || '').toUpperCase();
  if (/RTO|RETURN|CANCEL|UNDELIVERED/.test(s)) return 0;
  if (s.includes('OUT FOR DELIVERY'))          return 3;
  if (s.includes('DELIVERED'))                 return 4;
  if (/TRANSIT|SHIPPED|REACHED|HUB|DISPATCH/.test(s)) return 2;
  if (/PICK/.test(s))                          return 1;
  return 0;
}

// Customers see "DNT-2" on their receipt — accept that or just "2"
const orderNumber = v => String(v || '').replace(/\D/g, '');

// Read the server's error message instead of showing a misleading generic one
async function readError(res, fallback) {
  const body = await res.json().catch(() => ({}));
  return body.error || fallback;
}

export default function ShipmentPage({ onClose, initialOrderId = '' }) {
  const [awbInput, setAwbInput]     = useState('');
  const [orderInput, setOrderInput] = useState('');
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState('');

  const fetchByOrder = async (raw) => {
    const id = orderNumber(raw);
    if (!id) { setError('Enter your order ID, for example DNT-2.'); return; }
    setLoading(true); setError(''); setData(null);
    try {
      const res = await fetch(`/api/track/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(await readError(res, 'Could not fetch shipment details.'));
      setData(await res.json());
    } catch (e) {
      setError(e instanceof TypeError ? 'Network error. Please check your connection and try again.' : e.message);
    } finally { setLoading(false); }
  };

  const fetchByAWB = async (awb) => {
    if (!awb) return;
    setLoading(true); setError(''); setData(null);
    try {
      const res = await fetch(`/api/shipment/awb/${encodeURIComponent(awb.trim())}`);
      if (!res.ok) throw new Error(await readError(res, 'Could not fetch shipment details.'));
      setData(await res.json());
    } catch (e) {
      setError(e instanceof TypeError ? 'Network error. Please check your connection and try again.' : e.message);
    } finally { setLoading(false); }
  };

  // Auto-load: order passed in by the app (after checkout) or from a link
  // like  /#shipment?order=42  or  /#shipment?awb=123
  useEffect(() => {
    const hash   = window.location.hash;
    const params = new URLSearchParams(hash.includes('?') ? hash.split('?')[1] : '');
    const awb    = params.get('awb');
    const order  = initialOrderId || params.get('order');
    if (orderNumber(order)) { setOrderInput(`DNT-${orderNumber(order)}`); fetchByOrder(order); }
    else if (awb) { setAwbInput(awb); fetchByAWB(awb); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentStep = stepForStatus(data?.shipment_status);
  const isDelivered = currentStep === 4;

  return (
    <div className="ssp-page">
      {/* Header */}
      <div className="ssp-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {onClose && (
            <button onClick={onClose} style={{
              background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff',
              width: 36, height: 36, borderRadius: '50%', fontSize: '1rem', cursor: 'pointer',
            }}>←</button>
          )}
          <div>
            <div style={{ fontSize: '.65rem', letterSpacing: '.25em', textTransform: 'uppercase', color: 'rgba(255,255,255,.65)', marginBottom: 2 }}>Dentall</div>
            <div className="ssp-header-title" style={{ fontFamily: "'Fraunces', serif", fontSize: '1.3rem', fontWeight: 900, color: '#fff' }}>Shipment Details</div>
          </div>
        </div>
        <div style={{ fontSize: '1.5rem' }}>📦</div>
      </div>

      <div className="ssp-body">

        {/* Search bar */}
        <div style={{
          background: 'var(--white)', border: '1px solid var(--border-light)',
          borderRadius: 12, padding: '1.5rem', marginBottom: '1.5rem',
          boxShadow: 'var(--shadow-soft)',
        }}>
          <div style={{ fontSize: '.65rem', letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--text-light)', fontWeight: 700, marginBottom: '1rem' }}>
            Track your shipment
          </div>
          <div className="ssp-search-grid">
            <div>
              <label style={{ display: 'block', fontSize: '.68rem', color: 'var(--text-light)', textTransform: 'uppercase', letterSpacing: '.1em', fontWeight: 700, marginBottom: '.4rem' }}>
                Order ID
              </label>
              <div style={{ display: 'flex', gap: '.5rem' }}>
                <input
                  value={orderInput}
                  onChange={e => setOrderInput(e.target.value.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 20))}
                  placeholder="e.g. DNT-42"
                  onKeyDown={e => e.key === 'Enter' && fetchByOrder(orderInput)}
                  style={{ flex: 1, background: 'var(--off-white)', border: '1.5px solid var(--border-mid)', color: 'var(--text-dark)', padding: '.65rem .9rem', fontFamily: "'DM Sans',sans-serif", fontSize: '.86rem', borderRadius: 8, outline: 'none' }}
                />
                <button
                  onClick={() => fetchByOrder(orderInput)}
                  disabled={loading || !orderNumber(orderInput)}
                  style={{ background: 'linear-gradient(135deg,var(--primary),var(--primary-dark))', color: '#fff', border: 'none', padding: '.65rem 1rem', borderRadius: 8, fontFamily: "'DM Sans',sans-serif", fontSize: '.78rem', fontWeight: 700, cursor: 'pointer', opacity: (!orderNumber(orderInput) || loading) ? 0.5 : 1 }}>
                  Track
                </button>
              </div>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '.68rem', color: 'var(--text-light)', textTransform: 'uppercase', letterSpacing: '.1em', fontWeight: 700, marginBottom: '.4rem' }}>
                AWB / Tracking No.
              </label>
              <div style={{ display: 'flex', gap: '.5rem' }}>
                <input
                  value={awbInput}
                  onChange={e => setAwbInput(e.target.value)}
                  placeholder="e.g. SR1234567"
                  onKeyDown={e => e.key === 'Enter' && fetchByAWB(awbInput)}
                  style={{ flex: 1, background: 'var(--off-white)', border: '1.5px solid var(--border-mid)', color: 'var(--text-dark)', padding: '.65rem .9rem', fontFamily: "'DM Sans',sans-serif", fontSize: '.86rem', borderRadius: 8, outline: 'none' }}
                />
                <button
                  onClick={() => fetchByAWB(awbInput)}
                  disabled={loading || !awbInput}
                  style={{ background: 'linear-gradient(135deg,var(--primary),var(--primary-dark))', color: '#fff', border: 'none', padding: '.65rem 1rem', borderRadius: 8, fontFamily: "'DM Sans',sans-serif", fontSize: '.78rem', fontWeight: 700, cursor: 'pointer', opacity: (!awbInput || loading) ? 0.5 : 1 }}>
                  Track
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-light)' }}>
            <div style={{ width: 40, height: 40, border: '3px solid var(--border-mid)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin .7s linear infinite', margin: '0 auto 1rem' }} />
            Fetching shipment data from Shiprocket…
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{ background: 'rgba(255,61,87,.06)', border: '1px solid rgba(255,61,87,.2)', borderRadius: 8, padding: '1rem 1.2rem', color: 'var(--text-dark)', fontSize: '.85rem', marginBottom: '1rem' }}>
            ⚠ {error}
          </div>
        )}

        {/* Results */}
        {data && !loading && (
          <>
            <div style={{
              background: isDelivered
                ? 'linear-gradient(135deg, rgba(0,212,180,.08), rgba(0,212,180,.03))'
                : 'linear-gradient(135deg, var(--primary-muted), rgba(67,85,99,.04))',
              border: `1px solid ${isDelivered ? 'rgba(0,212,180,.3)' : 'var(--border-mid)'}`,
              borderRadius: 12, padding: '1.5rem', marginBottom: '1rem',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
                <div>
                  {data.order_id && (
                    <div style={{ fontSize: '.65rem', color: 'var(--text-light)', textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 4 }}>
                      Order #DNT-{data.order_id}
                    </div>
                  )}
                  <div style={{ fontFamily: "'Fraunces', serif", fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-dark)', marginBottom: 4 }}>
                    AWB: {data.awb_code || 'Being assigned'}
                  </div>
                  {data.courier_name && (
                    <div style={{ fontSize: '.8rem', color: 'var(--text-mid)' }}>via {data.courier_name}</div>
                  )}
                </div>
                <div style={{
                  background: isDelivered ? 'rgba(0,212,180,.12)' : 'var(--primary-muted)',
                  border: `1px solid ${isDelivered ? 'rgba(0,212,180,.3)' : 'var(--primary-muted)'}`,
                  color: isDelivered ? 'var(--success)' : 'var(--primary-dark)',
                  fontSize: '.72rem', fontWeight: 700, letterSpacing: '.1em',
                  textTransform: 'uppercase', padding: '.45rem 1rem', borderRadius: 20,
                }}>
                  {isDelivered ? '✓ Delivered' : (data.shipment_status || 'Processing')}
                </div>
              </div>

              {/* Progress steps */}
              <div className="ssp-steps">
                {STATUS_STEPS.map((step, i, arr) => {
                  const done   = i < currentStep;
                  const active = i === currentStep;
                  return (
                    <React.Fragment key={step}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 }}>
                        <div style={{
                          width: 28, height: 28, borderRadius: '50%',
                          background: done ? 'var(--success)' : active ? 'var(--primary)' : 'var(--white)',
                          border: `2px solid ${done ? 'var(--success)' : active ? 'var(--primary)' : 'var(--border-mid)'}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '.7rem', color: (done || active) ? '#fff' : 'var(--text-light)',
                          marginBottom: '.4rem', fontWeight: 700,
                          boxShadow: active ? '0 0 0 4px var(--primary-muted)' : 'none',
                        }}>
                          {done ? '✓' : i + 1}
                        </div>
                        <div style={{ fontSize: '.55rem', color: (done || active) ? 'var(--text-dark)' : 'var(--text-light)', textTransform: 'uppercase', letterSpacing: '.06em', textAlign: 'center', fontWeight: (done || active) ? 600 : 400, lineHeight: 1.3 }}>
                          {step}
                        </div>
                      </div>
                      {i < arr.length - 1 && (
                        <div style={{ flex: 1, height: 2, background: done ? 'var(--success)' : 'var(--border-mid)', marginTop: '-1.2rem', transition: 'background .3s' }} />
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>

            {data.message && (
              <div style={{ background: 'var(--white)', border: '1px solid var(--border-light)', borderRadius: 10, padding: '1rem', marginBottom: '1rem', fontSize: '.85rem', color: 'var(--text-mid)', lineHeight: 1.6 }}>
                {data.message}
              </div>
            )}

            {/* Meta grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '1rem', marginBottom: '1rem' }}>
              {[
                { label: 'Courier', value: data.courier_name || '—' },
                { label: 'Estimated delivery', value: data.etd || '—' },
                { label: 'Order date', value: data.order_date ? new Date(data.order_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—' },
                { label: 'Customer', value: data.customer_name || '—' },
              ].map(({ label, value }) => (
                <div key={label} style={{ background: 'var(--white)', border: '1px solid var(--border-light)', borderRadius: 10, padding: '1rem' }}>
                  <div style={{ fontSize: '.65rem', color: 'var(--text-light)', textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: '.9rem', fontWeight: 600, color: 'var(--text-dark)' }}>{value}</div>
                </div>
              ))}
            </div>

            {data.track_url && (
              <a href={data.track_url} target="_blank" rel="noopener noreferrer"
                 style={{ display: 'inline-block', marginBottom: '1rem', fontSize: '.82rem', fontWeight: 700, color: 'var(--primary)' }}>
                Open courier tracking page →
              </a>
            )}

            {/* Activity timeline */}
            {data.tracking_data?.length > 0 && (
              <div style={{ background: 'var(--white)', border: '1px solid var(--border-light)', borderRadius: 12, padding: '1.5rem' }}>
                <div style={{ fontSize: '.65rem', letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--text-light)', fontWeight: 700, marginBottom: '1.2rem' }}>
                  Activity log
                </div>
                <div>
                  {data.tracking_data.map((ev, i) => (
                    <div key={i} style={{ display: 'flex', gap: '1rem', paddingBottom: i < data.tracking_data.length - 1 ? '1rem' : 0 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 16, flexShrink: 0 }}>
                        <div style={{ width: 10, height: 10, borderRadius: '50%', background: i === 0 ? 'var(--primary)' : 'var(--border-mid)', marginTop: 4, flexShrink: 0 }} />
                        {i < data.tracking_data.length - 1 && (
                          <div style={{ width: 1, flex: 1, background: 'var(--border-light)', marginTop: 4 }} />
                        )}
                      </div>
                      <div style={{ paddingBottom: i < data.tracking_data.length - 1 ? '0.5rem' : 0 }}>
                        <div style={{ fontSize: '.85rem', fontWeight: i === 0 ? 600 : 400, color: i === 0 ? 'var(--text-dark)' : 'var(--text-mid)', marginBottom: 2 }}>
                          {ev.activity || ev.status}
                        </div>
                        <div style={{ fontSize: '.72rem', color: 'var(--text-light)' }}>
                          {ev.date}{ev.location ? ` — ${ev.location}` : ''}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {!data && !loading && !error && (
          <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-light)' }}>
            <div style={{ fontSize: '3rem', marginBottom: '1rem', opacity: .4 }}>📦</div>
            <div style={{ fontSize: '.88rem' }}>Enter your Order ID or AWB number above to see live shipment details from Shiprocket</div>
          </div>
        )}
      </div>
    </div>
  );
}
