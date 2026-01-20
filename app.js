import { ethers } from "https://esm.sh/ethers@6.13.4";
import { Options } from "https://esm.sh/@layerzerolabs/lz-v2-utilities@3.0.85";

// ========= YOUR CONSTANTS =========
const ADDRS = {
  BASE_OFT: "0xFbA669C72b588439B29F050b93500D8b645F9354",
  LINEA_ADAPTER: "0x54B4E88E9775647614440Accc8B13A079277fa2A6".replace("ccc", "cc"), // safety noop
  DTC_LINEA: "0xEb1fD1dBB8aDDA4fa2b5A5C4bcE34F6F20d125D2",
};

const CHAINS = {
  BASE:  { chainId: 8453,  name: "Base",  eid: 30184, currency: "ETH" },
  LINEA: { chainId: 59144, name: "Linea", eid: 30183, currency: "ETH" },
};

// ========= Minimal ABIs =========
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const OFT_ABI = [
  "function peer(uint32 dstEid) view returns (bytes32)",
  "function quoteSend((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) p, bool payInLzToken) view returns (uint256 nativeFee, uint256 lzTokenFee)",
  "function send((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) p, (uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress) payable returns (bytes32 guid, uint64 nonce, (uint256 amountSentLD,uint256 amountReceivedLD) receipt)"
];

// ========= UI =========
const $ = (id) => document.getElementById(id);

const logEl = $("log");
function log(msg) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent += `[${t}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function short(addr) {
  if (!addr) return "—";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function requireEthereum() {
  if (!window.ethereum) {
    alert("MetaMask not found. Install MetaMask and refresh.");
    throw new Error("No window.ethereum");
  }
  return window.ethereum;
}

// ========= Provider state =========
let browserProvider = null;
let signer = null;
let userAddress = null;

// Busy lock (prevents double-click overlap)
let BUSY = false;
async function withBusy(fn) {
  if (BUSY) return;
  BUSY = true;
  try { await fn(); }
  finally { BUSY = false; }
}

async function initProvider() {
  const eth = requireEthereum();
  browserProvider = new ethers.BrowserProvider(eth);
  signer = await browserProvider.getSigner();
  userAddress = await signer.getAddress();
}

async function getChainId() {
  const net = await browserProvider.getNetwork();
  return Number(net.chainId);
}

function toBytes32Address(addr) {
  return ethers.zeroPadValue(addr, 32);
}

function percentToMin(amountBN, slippagePct) {
  const slip = Number(slippagePct);
  const bps = Math.max(0, Math.min(100, slip)) * 100; // 0..10000
  const keepBps = 10000 - Math.round(bps);
  return (amountBN * BigInt(keepBps)) / 10000n;
}

function buildOptionsBytes(lzGas) {
  const gas = Number(lzGas);
  if (!Number.isFinite(gas) || gas <= 0) throw new Error("Invalid lzGas");
  // executorLzReceive option (gas, value=0)
  return Options.newOptions().addExecutorLzReceiveOption(gas, 0).toBytes();
}

function directionMeta() {
  const dir = $("direction").value;

  if (dir === "LINEA_TO_BASE") {
    return {
      from: CHAINS.LINEA,
      to: CHAINS.BASE,
      token: ADDRS.DTC_LINEA,          // approve token on Linea
      spender: ADDRS.LINEA_ADAPTER,    // spender = adapter
      sender: ADDRS.LINEA_ADAPTER,     // call send on adapter
      symbolHint: "DTC",
    };
  }

  // BASE_TO_LINEA
  return {
    from: CHAINS.BASE,
    to: CHAINS.LINEA,
    token: ADDRS.BASE_OFT,            // approve OFT on Base
    spender: ADDRS.BASE_OFT,
    sender: ADDRS.BASE_OFT,           // call send on OFT
    symbolHint: "DTC",
  };
}

async function ensureCorrectNetworkOrStop(targetChainId) {
  const chainId = await getChainId();
  if (chainId === targetChainId) return true;

  const targetName =
    targetChainId === CHAINS.LINEA.chainId ? "Linea" :
    targetChainId === CHAINS.BASE.chainId ? "Base" : String(targetChainId);

  log(`Wrong network (you are on ${chainId}). Please switch to ${targetName} and click again.`);
  return false;
}

async function switchNetwork(chainIdDec) {
  const eth = requireEthereum();
  const hex = "0x" + chainIdDec.toString(16);

  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    // If chain isn't added, add it
    if (e && (e.code === 4902 || String(e.message || "").includes("Unrecognized chain"))) {
      const params =
        chainIdDec === CHAINS.LINEA.chainId
          ? {
              chainId: hex,
              chainName: "Linea",
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: ["https://rpc.linea.build"],
              blockExplorerUrls: ["https://lineascan.build"],
            }
          : {
              chainId: hex,
              chainName: "Base",
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: ["https://mainnet.base.org"],
              blockExplorerUrls: ["https://basescan.org"],
            };
      await eth.request({ method: "wallet_addEthereumChain", params: [params] });
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } else {
      throw e;
    }
  }

  // IMPORTANT: after chain switch, re-init provider/signer
  await initProvider();
  $("netLine").textContent = `Network: ${await getChainId()}`;
  log(`Network changed. Provider re-initialized.`);
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

async function safeReadPeer(senderAddr, dstEid) {
  try {
    const c = new ethers.Contract(senderAddr, OFT_ABI, browserProvider);
    const peerBytes32 = await c.peer(dstEid);
    const asAddr = ethers.getAddress("0x" + peerBytes32.slice(26));
    return { peerBytes32, asAddr };
  } catch (e) {
    log(`Peer read failed: ${e?.shortMessage || e?.message || e}`);
    return null;
  }
}

async function refreshAll() {
  if (!signer || !userAddress) return;

  const meta = directionMeta();
  const chainId = await getChainId();

  $("netLine").textContent = `Network: ${chainId}`;
  $("walletLine").textContent = `Connected: ${short(userAddress)} (${userAddress})`;
  $("spenderLine").textContent = meta.spender;
  $("senderLine").textContent = meta.sender;

  // Only read token info if we're on the correct chain for that token
  if (chainId !== meta.from.chainId) {
    $("balLine").textContent = `Balance: — (switch to ${meta.from.name})`;
    $("peerLine").textContent = `— (switch to ${meta.from.name})`;
    return;
  }

  try {
    const { token, sym, dec } = await getTokenMeta(meta.token);
    const [bal, allowance] = await Promise.all([
      token.balanceOf(userAddress),
      token.allowance(userAddress, meta.spender),
    ]);

    $("balLine").textContent = `Balance: ${formatAmount(bal, dec)} ${sym}`;
    log(`Diag: chain=${meta.from.name} balance=${formatAmount(bal, dec)} ${sym} allowance=${formatAmount(allowance, dec)} ${sym}`);

    const peer = await safeReadPeer(meta.sender, meta.to.eid);
    if (peer) $("peerLine").textContent = `${peer.asAddr} (bytes32: ${peer.peerBytes32})`;
  } catch (e) {
    log(`Refresh error: ${e?.shortMessage || e?.message || e}`);
  }
}

async function quote() {
  const meta = directionMeta();
  if (!(await ensureCorrectNetworkOrStop(meta.from.chainId))) return null;

  const { sym, dec } = await getTokenMeta(meta.token);

  const amountStr = $("amount").value.trim();
  const slipStr = $("slippage").value.trim();
  const lzGas = $("lzGas").value.trim();

  const amount = parseAmount(amountStr, dec);
  const minAmount = percentToMin(amount, slipStr);

  const toB32 = toBytes32Address(userAddress);
  const extraOptions = buildOptionsBytes(lzGas);

  const sendParam = {
    dstEid: meta.to.eid,
    to: toB32,
    amountLD: amount,
    minAmountLD: minAmount,
    extraOptions: ethers.hexlify(extraOptions),
    composeMsg: "0x",
    oftCmd: "0x",
  };

  const sender = new ethers.Contract(meta.sender, OFT_ABI, browserProvider);

  log(`Quote: ${meta.from.name} → ${meta.to.name} sender=${meta.sender} amount=${amountStr} min=${formatAmount(minAmount, dec)} ${sym}`);

  const peer = await safeReadPeer(meta.sender, meta.to.eid);
  if (peer) log(`Diag: peer=${peer.asAddr}`);

  const [nativeFee] = await sender.quoteSend(sendParam, false);

  $("feeLine").textContent = `${ethers.formatEther(nativeFee)} ${meta.from.currency}`;
  log(`Native fee: ${ethers.formatEther(nativeFee)} ${meta.from.currency}`);

  return { meta, sendParam, nativeFee, dec, sym };
}

async function approveIfNeeded(q) {
  const meta = q.meta;
  if (!(await ensureCorrectNetworkOrStop(meta.from.chainId))) return false;

  const { token, sym, dec } = await getTokenMeta(meta.token);
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

async function sendFlow() {
  const meta = directionMeta();
  if (!(await ensureCorrectNetworkOrStop(meta.from.chainId))) return;

  // Always quote fresh
  const q = await quote();
  if (!q) return;

  const ok = await approveIfNeeded(q);
  if (!ok) return;

  const sender = new ethers.Contract(meta.sender, OFT_ABI, signer);
  const fee = { nativeFee: q.nativeFee, lzTokenFee: 0n };

  log(`Sending with msg.value=${ethers.formatEther(q.nativeFee)} ${meta.from.currency}...`);

  try {
    const tx = await sender.send(q.sendParam, fee, userAddress, { value: q.nativeFee });
    log(`Send tx: ${tx.hash}`);
    const rcpt = await tx.wait();
    log(`Send confirmed (source chain). status=${rcpt.status}`);
    log(`Delivery is async across chains.`);
  } catch (e) {
    log(`Send flow failed: ${e?.shortMessage || e?.message || e}`);
    log(`If Base→Linea fails, run Simulate with Debug RPC to extract selector + args.`);
  }
}

// ===== Debug simulate (eth_call) =====
async function simulateViaDebugRPC() {
  const meta = directionMeta();

  const rpc =
    meta.from.chainId === CHAINS.LINEA.chainId ? $("rpcLinea").value.trim()
    : $("rpcBase").value.trim();

  if (!rpc) {
    log(`Simulate failed: No Debug RPC URL set for ${meta.from.name}.`);
    return;
  }

  if (!(await ensureCorrectNetworkOrStop(meta.from.chainId))) return;

  const q = await quote();
  if (!q) return;

  const iface = new ethers.Interface(OFT_ABI);
  const data = iface.encodeFunctionData("send", [
    q.sendParam,
    { nativeFee: q.nativeFee, lzTokenFee: 0n },
    userAddress,
  ]);

  log(`SIMULATE (Debug RPC): ${meta.from.name} send() on ${meta.sender}`);

  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [
      {
        to: meta.sender,
        from: userAddress,
        data,
        value: ethers.toBeHex(q.nativeFee),
      },
      "latest",
    ],
  };

  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = await res.json();

  if (json.error) {
    const errData = json.error?.data;
    log(`eth_call reverted: ${json.error?.message || "execution reverted"}`);
    if (typeof errData === "string" && errData.startsWith("0x")) {
      log(`FOUND revert hex: ${errData}`);
      log(`selector: ${errData.slice(0, 10)}`);
    } else {
      log(`No revert hex found. Full error: ${JSON.stringify(json.error)}`);
    }
    return;
  }

  log(`eth_call OK (no revert). result=${json.result?.slice(0, 66) || json.result}`);
}

// ========= Wire up UI =========
$("btnConnect").onclick = () => withBusy(async () => {
  const eth = requireEthereum();

  // listeners (NO reload; just re-init provider)
  eth.removeAllListeners?.("chainChanged");
  eth.on?.("chainChanged", async () => {
    try {
      await initProvider();
      $("netLine").textContent = `Network: ${await getChainId()}`;
      log(`Network changed. Provider re-initialized.`);
      await refreshAll();
    } catch {}
  });

  eth.removeAllListeners?.("accountsChanged");
  eth.on?.("accountsChanged", async () => {
    try {
      await initProvider();
      log(`Account changed. Provider re-initialized.`);
      await refreshAll();
    } catch {}
  });

  await eth.request({ method: "eth_requestAccounts" });
  await initProvider();

  $("walletLine").textContent = `Connected: ${short(userAddress)} (${userAddress})`;
  $("netLine").textContent = `Network: ${await getChainId()}`;
  log(`Connected: ${userAddress}`);

  await refreshAll();
});

$("btnSwitchLinea").onclick = () => withBusy(async () => switchNetwork(CHAINS.LINEA.chainId));
$("btnSwitchBase").onclick  = () => withBusy(async () => switchNetwork(CHAINS.BASE.chainId));

$("btnRefresh").onclick = () => withBusy(refreshAll);
$("btnQuote").onclick   = () => withBusy(async () => { try { await quote(); } catch (e) { log(e?.message || String(e)); } });
$("btnApprove").onclick = () => withBusy(async () => { const q = await quote(); if (q) await approveIfNeeded(q); });
$("btnSend").onclick    = () => withBusy(sendFlow);

$("btnSimulate").onclick = () => withBusy(simulateViaDebugRPC);
$("btnClear").onclick = () => { logEl.textContent = ""; };

$("direction").onchange = () => withBusy(async () => {
  $("feeLine").textContent = "—";
  $("peerLine").textContent = "—";
  await refreshAll();
});

window.addEventListener("load", () => {
  $("spenderLine").textContent = "—";
  $("senderLine").textContent = "—";
  $("peerLine").textContent = "—";
  $("feeLine").textContent = "—";
  log(`Ready. Click "Connect Wallet".`);
});
