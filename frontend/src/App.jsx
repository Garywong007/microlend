import { useEffect, useState } from 'react';
import { useApp } from './context/AppContext.jsx';
import { shortAddr } from './lib/format.js';
import { Btn, Card, Loading, Toasts } from './components/ui.jsx';
import Overview from './pages/Overview.jsx';
import Borrower from './pages/Borrower.jsx';
import Lender from './pages/Lender.jsx';
import Officer from './pages/Officer.jsx';
import Auditor from './pages/Auditor.jsx';
import Admin from './pages/Admin.jsx';

const TABS = [
  { id: 'overview', label: 'Overview', roles: null, page: Overview },
  { id: 'borrow', label: 'Borrow', roles: ['borrower'], page: Borrower },
  { id: 'lend', label: 'Lend', roles: ['lender'], page: Lender },
  { id: 'officer', label: 'Credit officer', roles: ['officer', 'admin'], page: Officer },
  { id: 'audit', label: 'Audit', roles: ['auditor', 'admin'], page: Auditor },
  { id: 'admin', label: 'Admin', roles: ['admin'], page: Admin },
];
const STAFF = ['admin', 'officer', 'auditor'];

export default function App() {
  const app = useApp();
  const { config, bootError, account, session, wrongNetwork, hasWallet, connect, switchNetwork, signIn, signOut } = app;
  const [tab, setTab] = useState(() => window.location.hash.slice(1) || 'overview');

  const visible = TABS.filter((t) => !t.roles || (session && t.roles.some((r) => session.roles.includes(r))));
  const current = visible.find((t) => t.id === tab) || TABS[0];
  useEffect(() => {
    window.location.hash = current.id;
  }, [current.id]);

  const Page = current.page;
  const needsSession = current.roles !== null;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand"><span className="brand-mark">M</span> MicroLend</div>
          <div className="row">
            {config && <span className="chip" title={`chain id ${config.chainId}`}>{config.network}</span>}
            {session?.roles.filter((r) => STAFF.includes(r)).map((r) => <span key={r} className="chip">{r}</span>)}
            {!account ? (
              <Btn onClick={connect}>Connect wallet</Btn>
            ) : !session ? (
              <>
                <span className="mono small" title={account}>{shortAddr(account)}</span>
                <Btn onClick={signIn} disabled={wrongNetwork}>Sign in</Btn>
              </>
            ) : (
              <>
                <span className="mono small" title={session.address}>{shortAddr(session.address)}</span>
                <Btn variant="secondary" onClick={signOut}>Sign out</Btn>
              </>
            )}
          </div>
        </div>
        <nav className="tabs" aria-label="Sections">
          {visible.map((t) => (
            <button key={t.id} className="tab" aria-current={t.id === current.id ? 'page' : undefined} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </nav>
      </header>

      <main className="page">
        {bootError ? (
          <Card title="Cannot start"><p className="error-note">{bootError}</p></Card>
        ) : !config ? (
          <Loading />
        ) : (
          <>
            {!hasWallet && (
              <div className="banner banner-warn">MetaMask was not detected. You can browse the public overview, but you need the MetaMask extension to borrow, lend or manage the protocol.</div>
            )}
            {wrongNetwork && (
              <div className="banner banner-warn">
                <span>Your wallet is on the wrong network. This app uses chain {config.chainId} ({config.network}).</span>
                <Btn variant="secondary" onClick={switchNetwork}>Switch network</Btn>
              </div>
            )}
            {needsSession && !session ? (
              <Card title="Sign in required">
                <p>Connect your wallet and sign a message to continue. Signing is free and does not move any funds.</p>
              </Card>
            ) : needsSession && !app.me ? (
              <Loading />
            ) : (
              <Page />
            )}
          </>
        )}
      </main>
      <Toasts />
    </>
  );
}
