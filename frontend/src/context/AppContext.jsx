import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { api, setToken, loadToken } from '../lib/api.js';
import { friendlyError } from '../lib/format.js';

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

export function AppProvider({ children }) {
  const [config, setConfig] = useState(null);
  const [abis, setAbis] = useState(null);
  const [bootError, setBootError] = useState(null);
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [session, setSession] = useState(null); // { address, roles } once signed in
  const [me, setMe] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [version, setVersion] = useState(0); // bumped after every confirmed tx so pages refetch
  const walletProvider = useRef(null);
  const readProvider = useRef(null);

  const hasWallet = typeof window !== 'undefined' && !!window.ethereum;
  const wrongNetwork = !!(config && chainId && chainId !== config.chainId);

  // ---------- toasts ----------
  const notify = useCallback((kind, text, hash) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, kind, text, hash }]);
    if (kind === 'success' || kind === 'info') setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 8000);
    return id;
  }, []);
  const updateToast = useCallback((id, patch) => {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    if (patch.kind === 'success') setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 8000);
  }, []);
  const dismissToast = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const bump = useCallback(() => {
    setVersion((v) => v + 1);
    setTimeout(() => setVersion((v) => v + 1), 5000); // second refresh once the indexer has caught up
  }, []);

  // ---------- session ----------
  const refreshMe = useCallback(async () => {
    try {
      const data = await api.get('/me');
      setMe(data);
      setSession({ address: data.address, roles: data.roles });
      return data;
    } catch (e) {
      if (e.status === 401) {
        setToken(null);
        setSession(null);
        setMe(null);
      }
      return null;
    }
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setSession(null);
    setMe(null);
  }, []);

  // ---------- boot ----------
  useEffect(() => {
    (async () => {
      try {
        const [cfg, contractAbis] = await Promise.all([api.get('/config'), api.get('/abis')]);
        setConfig(cfg);
        setAbis(contractAbis);
        if (cfg.rpcUrl) {
          const net = ethers.Network.from(cfg.chainId);
          readProvider.current = new ethers.JsonRpcProvider(cfg.rpcUrl, net, { staticNetwork: net });
        }
      } catch (e) {
        setBootError(friendlyError(e));
        return;
      }
      // silently restore an earlier wallet connection and session
      if (window.ethereum) {
        try {
          const provider = new ethers.BrowserProvider(window.ethereum);
          const accounts = await provider.send('eth_accounts', []);
          if (accounts.length) {
            walletProvider.current = provider;
            setAccount(ethers.getAddress(accounts[0]));
            setChainId(Number((await provider.getNetwork()).chainId));
          }
        } catch {
          /* user has not connected yet */
        }
      }
      if (loadToken()) await refreshMe();
    })();
  }, [refreshMe]);

  // wallet events: switching network reloads the app, switching account signs out
  useEffect(() => {
    if (!window.ethereum) return undefined;
    const onAccounts = (accounts) => {
      setAccount(accounts[0] ? ethers.getAddress(accounts[0]) : null);
      signOut();
    };
    const onChain = () => window.location.reload();
    window.ethereum.on?.('accountsChanged', onAccounts);
    window.ethereum.on?.('chainChanged', onChain);
    return () => {
      window.ethereum.removeListener?.('accountsChanged', onAccounts);
      window.ethereum.removeListener?.('chainChanged', onChain);
    };
  }, [signOut]);

  // a session that belongs to a different wallet than the connected one is not valid
  useEffect(() => {
    if (session && account && session.address.toLowerCase() !== account.toLowerCase()) signOut();
  }, [session, account, signOut]);

  // ---------- wallet ----------
  const connect = useCallback(async () => {
    if (!window.ethereum) {
      notify('error', 'MetaMask was not found. Install the MetaMask browser extension and reload this page.');
      return;
    }
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await provider.send('eth_requestAccounts', []);
      walletProvider.current = provider;
      setAccount(ethers.getAddress(accounts[0]));
      setChainId(Number((await provider.getNetwork()).chainId));
    } catch (e) {
      notify('error', friendlyError(e));
    }
  }, [notify]);

  const switchNetwork = useCallback(async () => {
    if (!config) return;
    const hexId = `0x${config.chainId.toString(16)}`;
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
    } catch (e) {
      if (e.code === 4902 && config.rpcUrl) {
        try {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: hexId,
                chainName: `MicroLend (${config.network})`,
                nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                rpcUrls: [config.rpcUrl],
                ...(config.explorerUrl ? { blockExplorerUrls: [config.explorerUrl] } : {}),
              },
            ],
          });
        } catch (err) {
          notify('error', friendlyError(err));
        }
      } else {
        notify('error', friendlyError(e));
      }
    }
  }, [config, notify]);

  const signIn = useCallback(async () => {
    try {
      if (!walletProvider.current || !account) throw new Error('Connect your wallet first.');
      if (wrongNetwork) throw new Error(`Switch your wallet to chain ${config.chainId} first.`);
      const signer = await walletProvider.current.getSigner();
      const { message } = await api.post('/auth/nonce', { address: account });
      const signature = await signer.signMessage(message);
      const res = await api.post('/auth/verify', { address: account, signature });
      setToken(res.token);
      await refreshMe();
      notify('success', 'Signed in. Your roles were read from the blockchain.');
    } catch (e) {
      notify('error', friendlyError(e));
    }
  }, [account, config, notify, refreshMe, wrongNetwork]);

  // ---------- contracts ----------
  const reader = useCallback(
    (name) => {
      const runner = walletProvider.current && !wrongNetwork ? walletProvider.current : readProvider.current;
      if (!runner) throw new Error('No blockchain connection available. Connect your wallet.');
      return new ethers.Contract(config.contracts[name], abis[name], runner);
    },
    [abis, config, wrongNetwork]
  );

  const writer = useCallback(
    async (name) => {
      if (!walletProvider.current) throw new Error('Connect your wallet first.');
      if (wrongNetwork) throw new Error(`Switch your wallet to chain ${config.chainId} first.`);
      const signer = await walletProvider.current.getSigner();
      return new ethers.Contract(config.contracts[name], abis[name], signer);
    },
    [abis, config, wrongNetwork]
  );

  /** Runs a transaction with wallet-confirmation, pending and result toasts. Resolves to the receipt or null. */
  const runTx = useCallback(
    async (label, send) => {
      const id = notify('pending', `${label}: confirm in your wallet…`);
      try {
        const tx = await send();
        updateToast(id, { text: `${label}: submitted, waiting for confirmation…`, hash: tx.hash });
        const receipt = await tx.wait();
        updateToast(id, { kind: 'success', text: `${label}: confirmed`, hash: tx.hash });
        await refreshMe();
        bump();
        return receipt;
      } catch (e) {
        updateToast(id, { kind: 'error', text: `${label}: ${friendlyError(e)}` });
        return null;
      }
    },
    [bump, notify, refreshMe, updateToast]
  );

  /** Wraps non-transaction async actions (API calls) so failures are shown instead of thrown. */
  const run = useCallback(
    async (fn, label) => {
      try {
        return await fn();
      } catch (e) {
        notify('error', label ? `${label}: ${friendlyError(e)}` : friendlyError(e));
        return null;
      }
    },
    [notify]
  );

  const value = {
    config, abis, bootError, hasWallet, account, chainId, wrongNetwork, session, me, version, toasts,
    connect, switchNetwork, signIn, signOut, refreshMe, reader, writer, runTx, run, notify, dismissToast, bump,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
