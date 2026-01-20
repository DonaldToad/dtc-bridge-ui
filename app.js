import { ethers } from "https://esm.sh/ethers@6.13.4";
import { Options } from "https://esm.sh/@layerzerolabs/lz-v2-utilities@3.0.85";

// ========= YOUR CONSTANTS =========
const ADDRS = {
  BASE_OFT: "0xFbA669C72b588439B29F050b93500D8b645F9354",
  BASE_ROUTER: "0x480C0d523511dd96A65A38f36aaEF69aC2BaA82a",
  LINEA_ADAPTER: "0x54B4E88E9775647614440Acc8B13A079277fa2A6",
  DTC_LINEA: "0xEb1fD1dBB8aDDA4fa2b5A5C4bcE34F6F20d125D2",
};

const CHAINS = {
  BASE:  { chainId: 8453,  name: "Base",  eid: 30184, currency: "ETH" },
  LINEA: { chainId: 59144, name: "Linea", eid: 30183, currency: "ETH" },
};

// ========= ABIs =========
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

// OFT/Adapter interface (peer + quoteSend + send)
const OFT_ABI = [
  "function peer(uint32 dstEid) view returns (bytes32)",
  "function quoteSend((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) p, bool payInLzToken) view returns (uint256 nativeFee, uint256 lzTokenFee)",
  "function send((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) p, (uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress) payable returns (bytes32 guid, uint64 nonce, (uint256 amountSentLD,uint256 amountReceivedLD) receipt)"
];

// Router often exposes the same quoteSend/send surface:
const ROUTER_ABI = [
  "function quoteSend((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) p, bool payInLzToken) view returns (uint256 nativeFee, uint256 lzTokenFee)",
  "function send((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) p, (uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress) payable"
];

// ========= UI helpers =========
const $ = (id) => document.getElementById(id);

const LOG_KEY = "dtc_bridge_log_v1";
const logEl = $("log");

function loadLog() {
  const saved = localStorage.getItem(LOG_KEY);
  if (saved) logEl.textContent = saved;
}
function saveLog() {
  localStorage.setItem(LOG_KEY, logEl.textContent.slice(-50000)); // keep last ~50k chars
}
function log(msg) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent += `[${t}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
  saveLog();
}
function short(addr) {
  if (!addr) return "—";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}
function toBytes32Address(addr) {
  return ethers.zeroPadValue(addr, 32);
}
function percentToMin(amountBN, slippagePct) {
  const slip = Number(slippagePct);
  const bps = Math.max(0, Math.min(100, slip)) * 100; // 0..10000 bps
  const keepBps = 10000 - Math.round(bps);
  return (amountBN * BigInt(keepBps)) / 10000n;
}
function buildOptionsBytes(lzGas) {
  const gas = Number(lzGas);
  if (!Number.isFinite(gas) || gas <= 0) throw new Error("Invalid lzGas");
  return Options.newOptions().addExecutorLzReceiveOption(gas, 0).toBytes();
}

// ========= Provider state =========
let browserProvider = null;
let signer = null;
let userAddress = null;

// Prevent race conditions when chain changes mid-call
let sessionNonce = 0;
function bumpSession() { sessionNonce++; }
function mySession(n) { return n === sessionNonce; }

function requireEthereum() {
  if (!window.ethereum) {
    alert("MetaMask not found. Install MetaMask and refresh.");
    throw new Error("No window.ethereum");
  }
  return window.ethereum;
}

// We do NOT hard-reload on chainChanged.
// Instead, we recreate provider+signer and keep logs.
function installChainListeners() {
  const eth = requireEthereum();

  eth.removeAllListeners?.("chainChanged");
  eth.on?.("chainChanged", async () => {
    bumpSession();
    log(`Network changed. Re-initializing provider...`);
    await reinitProvider();
  });

  eth.removeAllListeners?.("accountsChanged");
  eth.on?.("accountsChanged", async (accs) => {
    bumpSession();
    if (!accs || !accs.length) return;
    log(`Account changed. Re-initializing provider...`);
    await reinitProvider();
  });
}

async function reinitProvider() {
  const eth = requireEthereum();
  browserProvider = new ethers.BrowserProvider(eth);
  signer = await browserProvider.getSigner();
  userAddress = await signer.getAddress();

  $("walletLine").textContent = `Connected: ${short(userAddress)} (${userAddress})`;
  await refreshAll();
}

async function connect() {
  const eth = requireEthereum();
  installChainListeners();

  await eth.request({ method: "eth_requestAccounts" });
  await reinitProvider();
  log(`Connected: ${userAddress}`);
}

async function getChainId() {
  if (!browserProvider) return null;
  const net = await browserProvider.getNetwork();
  return Number(net.chainId);
}

function getDirection() {
  return $("direction").value;
}

function setDirectionHint(meta) {
  $("directionHint").textContent =
    (meta.from.chainId === CHAINS.LINEA.chainId)
      ? "Linea is canonical (adapter lock/unlock). Base OFT is minted/burned."
      : "Base uses Router for bridging. Do NOT call OFT.send directly.";
}

// IMPORTANT FIX:
// - Linea→Base: approve DTC to LINEA_ADAPTER, call ADAPTER.quoteSend/send
// - Base→Linea: approve Base OFT to BASE_ROUTER, call ROUTER.quoteSend/send
function directionMeta() {
  const dir = getDirection();

  if (dir === "LINEA_TO_BASE") {
    return {
      from: CHAINS.LINEA,
      to: CHAINS.BASE,
      token: ADDRS.DTC_LINEA,
      spender: ADDRS.LINEA_ADAPTER,
      quoteContract: ADDRS.LINEA_ADAPTER,
      quoteAbi: OFT_ABI,
      sendContract: ADDRS.LINEA_ADAPTER,
      sendAbi: OFT_ABI,
      peerReadContract: ADDRS.LINEA_ADAPTER
    };
  }

  return {
    from: CHAINS.BASE,
    to: CHAINS.LINEA,
    token: ADDRS.BASE_OFT,
    spender: ADDRS.BASE_ROUTER,         // ✅ approve ROUTER
    quoteContract: ADDRS.BASE_ROUTER,   // ✅ quote on ROUTER
    quoteAbi: ROUTER_ABI,
    sendContract: ADDRS.BASE_ROUTER,    // ✅ send via ROUTER
    sendAbi: ROUTER_ABI,
    peerReadContract: ADDRS.BASE_OFT    // peer is typically on OFT
  };
}

async function switchNetwork(chainIdDec) {
  const eth = requireEthereum();
  const hex = "0x" + chainIdDec.toString(16);
  log(`Switching network to chainId=${chainIdDec}...`);

  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (e && (e.code === 4902 || String(e.message || "").includes("Unrecognized chain"))) {
      const params = (chainIdDec === CHAINS.LINEA.chainId)
        ? {
            chainId: hex,
            chainName: "Linea",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://rpc.linea.build"],
            blockExplorerUrls: ["https://lineascan.build"]
          }
        : {
            chainId: hex,
            chainName: "Base",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://mainnet.base.org"],
            blockExplorerUrls: ["https://basescan.org"]
          };
      await eth.request({ method: "wallet_addEthereumChain", params: [params] });
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } else {
      throw e;
    }
  }
}

async function getTokenMeta(tokenAddr) {
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, browserProvider);
  const [sym, dec] = await Promise.all([token.symbol(), token.decimals()]);
  return { token, sym, dec: Number(dec) };
}
function parseAmount(amountStr, decimals) {
  if (!amountStr || isNaN(Number(amountStr))) throw new Error("Invalid amount");
  return ethers.parseUnits(amountStr, decimals);
}
function formatAmount(amountBN, decimals) {
  return ethers.formatUnits(amountBN, decimals);
}

async function readPeer(peerReadContract, dstEid) {
  const c = new ethers.Contract(peerReadContract, ["function peer(uint32) view returns (bytes32)"], browserProvider);
  const peerBytes32 = await c.peer(dstEid);
  const asAddr = ethers.getAddress("0x" + peerBytes32.slice(26));
  return { peerBytes32, asAddr };
}

async function quote() {
  const n = sessionNonce;
  if (!signer) throw new Error("Not connected");

  const meta = directionMeta();
  setDirectionHint(meta);

  const chainId = await getChainId();
  $("netLine").textContent = `Network: ${chainId ?? "—"}`;

  if (!mySession(n)) return;

  if (chainId !== meta.from.chainId) {
    log(`Wrong network. Switching to ${meta.from.name}...`);
    await switchNetwork(meta.from.chainId);
    return null;
  }

  const { token, sym, dec } = await getTokenMeta(meta.token);
  if (!mySession(n)) return;

  const amountStr = $("amount").value.trim();
  const slipStr = $("slippage").value.trim();
  const lzGas = $("lzGas").value.trim();

  const amount = parseAmount(amountStr, dec);
  const minAmount = percentToMin(amount, slipStr);
  const toB32 = toBytes32Address(userAddress);
  const extraOptions = buildOptionsBytes(lzGas);

  const p = {
    dstEid: meta.to.eid,
    to: toB32,
    amountLD: amount,
    minAmountLD: minAmount,
    extraOptions: ethers.hexlify(extraOptions),
    composeMsg: "0x",
    oftCmd: "0x"
  };

  $("spenderLine").textContent = meta.spender;
  $("senderLine").textContent = meta.sendContract;

  log(`Quote: ${meta.from.name} → ${meta.to.name} quoteOn=${meta.quoteContract} amount=${amountStr} min=${formatAmount(minAmount, dec)} ${sym}`);

  // Peer sanity
  try {
    const peer = await readPeer(meta.peerReadContract, meta.to.eid);
    $("peerLine").textContent = `${peer.asAddr} (bytes32: ${peer.peerBytes32})`;
    log(`Diag: peer=${peer.asAddr}`);
  } catch (e) {
    $("peerLine").textContent = `— (peer read failed)`;
    log(`Peer read failed: ${e?.shortMessage || e?.message || e}`);
  }

  const q = new ethers.Contract(meta.quoteContract, meta.quoteAbi, browserProvider);
  const res = await q.quoteSend(p, false);
  const nativeFee = res[0];
  $("feeLine").textContent = `${ethers.formatEther(nativeFee)} ${meta.from.currency}`;
  log(`Native fee: ${ethers.formatEther(nativeFee)} ${meta.from.currency}`);

  return { meta, token, sym, dec, p, nativeFee };
}

async function approveIfNeeded() {
  const n = sessionNonce;
  if (!signer) throw new Error("Not connected");

  const meta = directionMeta();
  const chainId = await getChainId();
  if (!mySession(n)) return false;

  if (chainId !== meta.from.chainId) {
    log(`Wrong network. Switching to ${meta.from.name}...`);
    await switchNetwork(meta.from.chainId);
    return false;
  }

  const { token, sym, dec } = await getTokenMeta(meta.token);
  if (!mySession(n)) return false;

  const amountStr = $("amount").value.trim();
  const amount = parseAmount(amountStr, dec);

  const allowance = await token.allowance(userAddress, meta.spender);
  if (allowance >= amount) {
    log(`Approve not needed. allowance=${formatAmount(allowance, dec)} ${sym}`);
    return true;
  }

  log(`Approving spender=${meta.spender} for ${amountStr} ${sym}...`);
  const tx = await token.connect(signer).approve(meta.spender, amount);
  log(`Approve tx: ${tx.hash}`);
  await tx.wait();
  log(`Approve confirmed.`);
  return true;
}

async function send() {
  const n = sessionNonce;
  if (!signer) throw new Error("Not connected");

  const q = await quote(); // always re-quote so msg.value is exact
  if (!q || !mySession(n)) return;

  await approveIfNeeded();
  if (!mySession(n)) return;

  const fee = { nativeFee: q.nativeFee, lzTokenFee: 0n };

  log(`Sending via ${q.meta.sendContract} with msg.value=${ethers.formatEther(q.nativeFee)} ETH...`);

  try {
    const sender = new ethers.Contract(q.meta.sendContract, q.meta.sendAbi, signer);
    const tx = await sender.send(q.p, fee, userAddress, { value: q.nativeFee });
    log(`Send tx: ${tx.hash}`);
    const rcpt = await tx.wait();
    log(`Send confirmed. status=${rcpt.status} (delivery is async across chains)`);
  } catch (e) {
    log(`Send failed: ${e?.shortMessage || e?.message || e}`);
    log(`Tip: If it says "missing revert data", use Debug RPC + Simulate to extract selector.`);
  }
}

async function refreshAll() {
  const n = sessionNonce;
  if (!signer) return;

  const meta = directionMeta();
  setDirectionHint(meta);

  const chainId = await getChainId();
  $("netLine").textContent = `Network: ${chainId ?? "—"}`;
  $("spenderLine").textContent = meta.spender;
  $("senderLine").textContent = meta.sendContract;

  try {
    const { token, sym, dec } = await getTokenMeta(meta.token);
    if (!mySession(n)) return;

    const bal = await token.balanceOf(userAddress);
    $("balLine").textContent = `Balance: ${formatAmount(bal, dec)} ${sym}`;

    if (chainId === meta.from.chainId) {
      const allowance = await token.allowance(userAddress, meta.spender);
      log(`Diag: chain=${meta.from.name} balance=${formatAmount(bal, dec)} ${sym} allowance=${formatAmount(allowance, dec)} ${sym}`);
    }
  } catch (e) {
    log(`Refresh error: ${e?.shortMessage || e?.message || e}`);
  }
}

async function simulateViaDebugRPC() {
  const n = sessionNonce;
  if (!signer) throw new Error("Not connected");

  const q = await quote();
  if (!q || !mySession(n)) return;

  const rpc = (q.meta.from.chainId === CHAINS.LINEA.chainId) ? $("rpcLinea").value.trim() : $("rpcBase").value.trim();
  if (!rpc) {
    log(`Simulate failed: No Debug RPC URL set for ${q.meta.from.name}.`);
    return;
  }

  const iface = new ethers.Interface(q.meta.sendAbi);
  const data = iface.encodeFunctionData("send", [q.p, { nativeFee: q.nativeFee, lzTokenFee: 0n }, userAddress]);

  log(`SIMULATE (Debug RPC): ${q.meta.from.name} send()`);

  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{
      to: q.meta.sendContract,
      from: userAddress,
      data,
      value: ethers.toBeHex(q.nativeFee)
    }, "latest"]
  };

  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const json = await res.json();

    if (json.error) {
      const errData = json.error?.data;
      log(`eth_call reverted. message=${json.error?.message || "—"}`);

      if (typeof errData === "string" && errData.startsWith("0x")) {
        log(`FOUND revert hex: ${errData}`);
        log(`selector: ${errData.slice(0, 10)}`);
      } else {
        log(`No revert hex found. Full error: ${JSON.stringify(json.error)}`);
      }
      return;
    }

    log(`eth_call OK (no revert). result=${(json.result || "").slice(0, 66)}...`);
  } catch (e) {
    log(`Simulate failed: ${e?.message || e}`);
  }
}

// ========= Wire up UI =========
$("btnConnect").onclick = () => connect().catch(e => log(`Connect failed: ${e?.message || e}`));
$("btnSwitchLinea").onclick = () => switchNetwork(CHAINS.LINEA.chainId).catch(e => log(`Switch failed: ${e?.message || e}`));
$("btnSwitchBase").onclick = () => switchNetwork(CHAINS.BASE.chainId).catch(e => log(`Switch failed: ${e?.message || e}`));

$("btnRefresh").onclick = () => refreshAll();
$("btnQuote").onclick = () => quote().catch(e => log(`Quote failed: ${e?.shortMessage || e?.message || e}`));
$("btnApprove").onclick = () => approveIfNeeded().catch(e => log(`Approve failed: ${e?.shortMessage || e?.message || e}`));
$("btnSend").onclick = () => send().catch(e => log(`Send flow failed: ${e?.shortMessage || e?.message || e}`));
$("btnSimulate").onclick = () => simulateViaDebugRPC().catch(e => log(`Simulate failed: ${e?.message || e}`));

$("btnClear").onclick = () => {
  logEl.textContent = "";
  localStorage.removeItem(LOG_KEY);
};

$("direction").onchange = () => {
  $("feeLine").textContent = "—";
  $("peerLine").textContent = "—";
  refreshAll();
};

window.addEventListener("load", () => {
  loadLog();
  $("netLine").textContent = "Network: —";
  $("walletLine").textContent = "Not connected";
  $("spenderLine").textContent = "—";
  $("senderLine").textContent = "—";
  $("peerLine").textContent = "—";
  $("feeLine").textContent = "—";
  log(`Ready. Click "Connect Wallet".`);
});
