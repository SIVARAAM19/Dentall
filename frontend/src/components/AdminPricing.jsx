import { useEffect, useState } from "react";
import AdminDealers from "./AdminDealers";

const TOKEN_KEY = 'dn_admin_token';
const PRODUCT_NAMES = { 'family-pack': 'Family Pack (12 brushes)' };

export default function AdminPricing() {
  const [checking, setChecking]     = useState(true);
  const [authed, setAuthed]         = useState(false);
  const [token, setToken]           = useState('');
  const [loginInput, setLoginInput] = useState('');
  const [loginError, setLoginError] = useState('');

  const [drafts, setDrafts]   = useState({});
  const [saving, setSaving]   = useState({});
  const [message, setMessage] = useState({});

  const [coupons, setCoupons]         = useState([]);
  const [newCode, setNewCode]         = useState('');
  const [newPercent, setNewPercent]   = useState('');
  const [couponSaving, setCouponSaving] = useState(false);
  const [couponMsg, setCouponMsg]     = useState(null);

  const verifyToken = async (t) => {
    try {
      const res = await fetch('/api/admin/ping', { headers: { 'x-admin-token': t } });
      if (res.ok) {
        sessionStorage.setItem(TOKEN_KEY, t);
        setToken(t);
        setAuthed(true);
        return true;
      }
      sessionStorage.removeItem(TOKEN_KEY);
      setAuthed(false);
      return false;
    } catch {
      setAuthed(false);
      return false;
    }
  };

  useEffect(() => {
    const saved = sessionStorage.getItem(TOKEN_KEY);
    if (saved) verifyToken(saved).finally(() => setChecking(false));
    else setChecking(false);
  }, []);

  useEffect(() => {
    if (!authed) return;
    fetch('/api/pricing')
      .then(r => r.json())
      .then(data => {
        const d = {};
        for (const [id, v] of Object.entries(data)) d[id] = { price: v.price, mrp: v.mrp ?? '' };
        setDrafts(d);
      });
    fetchCoupons(token);
  }, [authed]);

  const fetchCoupons = async (t) => {
    try {
      const res = await fetch('/api/admin/coupons', { headers: { 'x-admin-token': t } });
      if (res.ok) setCoupons(await res.json());
    } catch { /* non-fatal */ }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    const ok = await verifyToken(loginInput);
    if (!ok) setLoginError('Incorrect admin password.');
  };

  const handleLogout = () => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken('');
    setAuthed(false);
  };

  const setDraft = (id, field, value) =>
    setDrafts(d => ({ ...d, [id]: { ...d[id], [field]: value } }));

  const saveProduct = async (id) => {
    setSaving(s => ({ ...s, [id]: true }));
    setMessage(m => ({ ...m, [id]: null }));
    try {
      const body = {
        productId: id,
        price: Number(drafts[id].price),
        mrp:   drafts[id].mrp === '' ? null : Number(drafts[id].mrp),
      };
      const res  = await fetch('/api/admin/pricing', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
        body:    JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setMessage(m => ({ ...m, [id]: { type: 'ok', text: 'Saved — live on the site now.' } }));
    } catch (err) {
      setMessage(m => ({ ...m, [id]: { type: 'err', text: err.message } }));
    } finally {
      setSaving(s => ({ ...s, [id]: false }));
    }
  };

  const createCoupon = async (e) => {
    e.preventDefault();
    setCouponSaving(true);
    setCouponMsg(null);
    try {
      const res = await fetch('/api/admin/coupons', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
        body:    JSON.stringify({ code: newCode, discountPercent: Number(newPercent), active: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save coupon');
      setNewCode('');
      setNewPercent('');
      setCouponMsg({ type: 'ok', text: `Saved — ${data.code} gives ${data.discountPercent}% off.` });
      fetchCoupons(token);
    } catch (err) {
      setCouponMsg({ type: 'err', text: err.message });
    } finally {
      setCouponSaving(false);
    }
  };

  const toggleCoupon = async (c) => {
    await fetch('/api/admin/coupons', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
      body:    JSON.stringify({ code: c.code, discountPercent: c.discountPercent, active: !c.active }),
    });
    fetchCoupons(token);
  };

  const deleteCoupon = async (code) => {
    await fetch(`/api/admin/coupons/${code}`, { method: 'DELETE', headers: { 'x-admin-token': token } });
    fetchCoupons(token);
  };

  if (checking) {
    return <div className="dn-admin-wrap"><div className="dn-admin-card">Checking session…</div></div>;
  }

  if (!authed) {
    return (
      <div className="dn-admin-wrap">
        <form className="dn-admin-card" onSubmit={handleLogin}>
          <h1 className="dn-admin-title">Admin login</h1>
          <p className="dn-admin-sub">Enter the admin password to manage pricing.</p>
          <input
            type="password"
            autoFocus
            value={loginInput}
            onChange={e => setLoginInput(e.target.value)}
            placeholder="Admin password"
            className="dn-admin-input"
          />
          {loginError && <div className="dn-admin-error">{loginError}</div>}
          <button className="dn-admin-btn" type="submit">Log in</button>
        </form>
      </div>
    );
  }

  return (
    <div className="dn-admin-wrap dn-admin-wrap-stack">
      <div className="dn-admin-card dn-admin-card-wide">
        <div className="dn-admin-header">
          <h1 className="dn-admin-title">Pricing</h1>
          <button className="dn-admin-logout" onClick={handleLogout}>Log out</button>
        </div>
        <p className="dn-admin-sub">
          Changes here update the live site and checkout price immediately — no redeploy needed.
        </p>

        {Object.keys(drafts).length === 0 && <p>Loading…</p>}

        {Object.entries(drafts).map(([id, d]) => (
          <div key={id} className="dn-admin-product">
            <div className="dn-admin-product-name">{PRODUCT_NAMES[id] || id}</div>
            <div className="dn-admin-row">
              <label>
                Price (₹)
                <input
                  type="number"
                  min="1"
                  value={d.price}
                  onChange={e => setDraft(id, 'price', e.target.value)}
                  className="dn-admin-input"
                />
              </label>
              <label>
                MRP (₹) — optional, for strike-through
                <input
                  type="number"
                  min="0"
                  value={d.mrp}
                  onChange={e => setDraft(id, 'mrp', e.target.value)}
                  placeholder="Leave blank for no offer badge"
                  className="dn-admin-input"
                />
              </label>
            </div>
            {d.mrp && Number(d.mrp) > Number(d.price) && (
              <div className="dn-admin-preview">
                Preview: <s>₹{d.mrp}</s> ₹{d.price} · {Math.round(((d.mrp - d.price) / d.mrp) * 100)}% OFF badge
              </div>
            )}
            <button
              className="dn-admin-btn"
              disabled={saving[id]}
              onClick={() => saveProduct(id)}
            >
              {saving[id] ? 'Saving…' : 'Save'}
            </button>
            {message[id] && (
              <div className={message[id].type === 'ok' ? 'dn-admin-success' : 'dn-admin-error'}>
                {message[id].text}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="dn-admin-card dn-admin-card-wide">
        <h1 className="dn-admin-title">Coupon codes</h1>
        <p className="dn-admin-sub">
          Customers enter these at checkout for an instant % discount. Toggle a code off to pause it without deleting it.
        </p>

        <form onSubmit={createCoupon} className="dn-admin-row" style={{ alignItems: 'end' }}>
          <label>
            Code
            <input
              value={newCode}
              onChange={e => setNewCode(e.target.value.toUpperCase())}
              placeholder="WELCOME20"
              className="dn-admin-input"
              required
            />
          </label>
          <label>
            Discount %
            <input
              type="number"
              min="1"
              max="90"
              value={newPercent}
              onChange={e => setNewPercent(e.target.value)}
              placeholder="20"
              className="dn-admin-input"
              required
            />
          </label>
          <button className="dn-admin-btn" type="submit" disabled={couponSaving} style={{ marginTop: 0, height: 42 }}>
            {couponSaving ? 'Saving…' : 'Add / Update'}
          </button>
        </form>
        {couponMsg && (
          <div className={couponMsg.type === 'ok' ? 'dn-admin-success' : 'dn-admin-error'}>
            {couponMsg.text}
          </div>
        )}

        {coupons.length > 0 && (
          <div className="dn-admin-coupon-list">
            {coupons.map(c => (
              <div key={c.code} className="dn-admin-coupon-row">
                <span className="dn-admin-coupon-code">{c.code}</span>
                <span>{c.discountPercent}% off</span>
                <span className={c.active ? 'dn-admin-success' : 'dn-admin-error'} style={{ margin: 0, padding: 0, background: 'none' }}>
                  {c.active ? 'Active' : 'Paused'}
                </span>
                <button className="dn-admin-logout" onClick={() => toggleCoupon(c)}>
                  {c.active ? 'Pause' : 'Activate'}
                </button>
                <button className="dn-admin-logout" onClick={() => deleteCoupon(c.code)}>Delete</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <AdminDealers token={token} />
    </div>
  );
}
