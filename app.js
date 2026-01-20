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

const OFT_ABI = [
  // NOTE: some OFTs have peers(uint32) not peer(uint32). We'll call peers() via a separate ABI.
  "function quoteSend((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) p, bool payInLzToken) view returns (uint256 nativeFee, uint256 lzTokenFee)",
  "function send((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) p, (uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress) payable returns (bytes32 guid, uint64 nonce, (uint256 amountSentLD,uint256 amountReceivedLD) receipt)"
];

// Router send wrapper (some routers just forward; return value often none)
const ROUTER_ABI = [
  "function send((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) p, (uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress) payable"
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

function toBytes32Address(addr) {
  return ethers.zeroPadValue(addr, 32);
}

function percentToMin(amountBN, slippagePct) {
  const slip = Number(slippagePct);
  const bps = Math.max(0, Math.min(100, slip)) * 100; // 0..10000 bps
  const keepBps = 10000 - Math.round(bps);
  return (amountBN * BigInt(keepBps)) / 10000n;
}

// ========= Provider state =========
let browserProvider = null;
let signer = null;
let userAddress = null;

// ========= Helpers =========
function requireEthereum() {
  if (!window.ethereum) {
    alert("MetaMask (or another wallet) not found. Install MetaMask and refresh.");
    throw new Error("No window.ethereum");
  }
  return window.ethereum;
}

async function reinitProvider() {
  const eth = requireEthereum();
  browserProvider = new ethers.BrowserProvider(eth);
  signer = await browserProvider.getSigner();
  userAddress = await signer.getAddress();
  $("walletLine").textContent = `Connected: ${short(userAddress)} (${userAddress})`;
}

function installChainListeners() {
  const eth = requireEthereum();

  // Avoid multiple bindings if file hot-reloaded/cached
  try { eth.removeAllListeners?.("chainChanged"); } catch (_) {}
  try { eth.removeAllListeners?.("accountsChanged"); } catch (_) {}

  // We do NOT hard-reload anymore; we re-init provider cleanly.
  eth.on?.("chainChanged", async () => {
    try {
      await reinitProvider();
      log(`Network changed. Provider re-initialized.`);
      await refreshAll();
    } catch (e) {
      log(`Network changed re-init failed: ${e?.message || e}`);
    }
  });

  eth.on?.("accountsChanged", async (accs) => {
    if (!accs || !accs.length) return;
    try {
      await reinitProvider();
      log(`Account changed. Provider re-initialized.`);
      await refreshAll();
    } catch (e) {
      log(`Account change re-init failed: ${e?.message || e}`);
    }
  });
}

async function connect() {
  const eth = requireEthereum();
  installChainListeners();

  await eth.request({ method: "eth_requestAccounts" });
  await reinitProvider();

  log(`Connected: ${userAddress}`);
  await refreshAll();
}

async function getChainId() {
  if (!browserProvider) return null;
  const net = await browserProvider.getNetwork();
  return Number(net.chainId);
}

function getDirection() {
  return $("direction").value;
}

// IMPORTANT: Base->Linea must SEND via Router (NotRouter() otherwise)
// Also approve spender = Router (not token)
function directionMeta() {
  const dir = getDirection();
  if (dir === "LINEA_TO_BASE") {
    return {
      from: CHAINS.LINEA,
      to: CHAINS.BASE,
      token: ADDRS.DTC_LINEA,
      spender: ADDRS.LINEA_ADAPTER,     // approve adapter to pull DTC on Linea
      sender: ADDRS.LINEA_ADAPTER,      // send through adapter on Linea
      quoteOn: ADDRS.LINEA_ADAPTER,
      senderType: "OFT"
    };
  }

  // BASE_TO_LINEA
  return {
    from: CHAINS.BASE,
    to: CHAINS.LINEA,
    token: ADDRS.BASE_OFT,             // token you spend on Base
    spender: ADDRS.BASE_ROUTER,        // approve router to spend Base OFT
    sender: ADDRS.BASE_ROUTER,         // send via router to avoid NotRouter()
    quoteOn: ADDRS.BASE_OFT,           // quote on OFT (router quote may not exist)
    senderType: "ROUTER"
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

  // Critical: rebuild provider after switch to prevent ethers NETWORK_ERROR spam
  await reinitProvider();
  log(`Network switched. Provider re-initialized.`);
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

function buildOptionsBytes(lzGas) {
  const gas = Number(lzGas);
  if (!Number.isFinite(gas) || gas <= 0) throw new Error("Invalid lzGas");
  // Official Options builder
  return Options.newOptions().addExecutorLzReceiveOption(gas, 0).toBytes();
}

// Read peer safely: prefer peers(uint32) (your ABI), fallback to peer(uint32)
async function readPeerAny(contractAddr, dstEid) {
  const peersAbi = ["function peers(uint32) view returns (bytes32)"];
  const peerAbi  = ["function peer(uint32) view returns (bytes32)"];

  try {
    const c = new ethers.Contract(contractAddr, peersAbi, browserProvider);
    const peerBytes32 = await c.peers(dstEid);
    const asAddr = ethers.getAddress("0x" + peerBytes32.slice(26));
    return { peerBytes32, asAddr };
  } catch (_) {
    const c = new ethers.Contract(contractAddr, peerAbi, browserProvider);
    const peerBytes32 = await c.peer(dstEid);
    const asAddr = ethers.getAddress("0x" + peerBytes32.slice(26));
    return { peerBytes32, asAddr };
  }
}

async function quote() {
  if (!signer) throw new Error("Not connected");
  const meta = directionMeta();

  const chainId = await getChainId();
  if (chainId !== meta.from.chainId) {
    log(`Wrong network. Switching to ${meta.from.name}...`);
    await switchNetwork(meta.from.chainId);
  }

  const { token, sym, dec } = await getTokenMeta(meta.token);

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
    oftCmd: "0x"
  };

  log(`Quote: ${meta.from.name} → ${meta.to.name} quoteOn=${meta.quoteOn} amount=${amountStr} min=${formatAmount(minAmount, dec)} ${sym}`);

  // Peer read: for Linea->Base read on adapter; for Base->Linea read on OFT
  try {
    const peer = await readPeerAny(meta.quoteOn, meta.to.eid);
    $("peerLine").textContent = `${peer.asAddr} (bytes32: ${peer.peerBytes32})`;
    log(`Diag: peer=${peer.asAddr}`);
  } catch (e) {
    $("peerLine").textContent = `Peer read failed`;
    log(`Peer read failed: ${e?.shortMessage || e?.message || e}`);
  }

  // Quote on OFT/adapter
  const quoteContract = new ethers.Contract(meta.quoteOn, OFT_ABI, browserProvider);

  try {
    const res = await quoteContract.quoteSend(sendParam, false);
    const nativeFee = res[0];
    const lzTokenFee = res[1];

    $("feeLine").textContent = `${ethers.formatEther(nativeFee)} ${meta.from.currency}`;
    $("spenderLine").textContent = meta.spender;
    $("senderLine").textContent = meta.sender;

    log(`Native fee: ${ethers.formatEther(nativeFee)} ${meta.from.currency}`);

    return { sendParam, nativeFee, lzTokenFee, token, sym, dec, meta };
  } catch (e) {
    log(`Quote failed: ${e?.shortMessage || e?.message || e}`);
    throw e;
  }
}

async function approveIfNeeded(q) {
  if (!signer) throw new Error("Not connected");

  const meta = q?.meta || directionMeta();
  const chainId = await getChainId();
  if (chainId !== meta.from.chainId) {
    log(`Wrong network. Switching to ${meta.from.name}...`);
    await switchNetwork(meta.from.chainId);
  }

  const { token, sym, dec } = await getTokenMeta(meta.token);
  const amountStr = $("amount").value.trim();
  const amount = parseAmount(amountStr, dec);

  const allowance = await token.allowance(userAddress, meta.spender);
  if (allowance >= amount) {
    log(`Approve not needed. allowance=${formatAmount(allowance, dec)} ${sym}`);
    return true;
  }

  const tokenWithSigner = token.connect(signer);
  log(`Approving spender=${meta.spender} for ${amountStr} ${sym}...`);
  const tx = await tokenWithSigner.approve(meta.spender, amount);
  log(`Approve tx: ${tx.hash}`);
  await tx.wait();
  log(`Approve confirmed.`);
  return true;
}

async function send() {
  if (!signer) throw new Error("Not connected");

  const meta = directionMeta();
  const chainId = await getChainId();

  if (chainId !== meta.from.chainId) {
    log(`Wrong network. Switching to ${meta.from.name}...`);
    await switchNetwork(meta.from.chainId);
  }

  // Always re-quote right before send
  const q = await quote();
  await approveIfNeeded(q);

  const fee = { nativeFee: q.nativeFee, lzTokenFee: 0n };

  log(`Sending with msg.value=${ethers.formatEther(q.nativeFee)} ${meta.from.currency}...`);

  try {
    if (meta.senderType === "ROUTER") {
      // Base -> Linea MUST go via router (fixes NotRouter() / selector 0x91655201)
      const router = new ethers.Contract(meta.sender, ROUTER_ABI, signer);
      const tx = await router.send(q.sendParam, fee, userAddress, { value: q.nativeFee });
      log(`Send tx: ${tx.hash}`);
      const rcpt = await tx.wait();
      log(`Send confirmed (source chain). status=${rcpt.status}`);
      log(`Delivery is async across chains.`);
    } else {
      // Linea -> Base via adapter (OFT send)
      const oft = new ethers.Contract(meta.sender, OFT_ABI, signer);
      const tx = await oft.send(q.sendParam, fee, userAddress, { value: q.nativeFee });
      log(`Send tx: ${tx.hash}`);
      const rcpt = await tx.wait();
      log(`Send confirmed (source chain). status=${rcpt.status}`);
      log(`Delivery is async across chains.`);
    }
  } catch (e) {
    log(`Send failed: ${e?.shortMessage || e?.message || e}`);
    throw e;
  }
}

async function refreshAll() {
  if (!signer) return;

  const meta = directionMeta();
  const chainId = await getChainId();

  $("netLine").textContent = `Network: ${chainId || "—"}`;
  $("spenderLine").textContent = meta.spender;
  $("senderLine").textContent = meta.sender;

  try {
    const { token, sym, dec } = await getTokenMeta(meta.token);
    const bal = await token.balanceOf(userAddress);
    $("balLine").textContent = `Balance: ${formatAmount(bal, dec)} ${sym}`;

    // Only read allowance on current chain (avoid confusing errors)
    if (chainId === meta.from.chainId) {
      const allowance = await token.allowance(userAddress, meta.spender);
      log(`Diag: chain=${meta.from.name} balance=${formatAmount(bal, dec)} ${sym} allowance=${formatAmount(allowance, dec)} ${sym}`);
    }
  } catch (e) {
    log(`Refresh error: ${e?.shortMessage || e?.message || e}`);
  }

  // Peer line attempt (non-fatal)
  try {
    if (chainId === meta.from.chainId) {
      const peer = await readPeerAny(meta.quoteOn, meta.to.eid);
      $("peerLine").textContent = `${peer.asAddr} (bytes32: ${peer.peerBytes32})`;
    } else {
      $("peerLine").textContent = `— (switch to ${meta.from.name} to read peer)`;
    }
  } catch (e) {
    $("peerLine").textContent = `Peer read failed`;
  }
}

// ===== Debug simulation (optional) =====
async function simulateViaDebugRPC() {
  if (!signer) throw new Error("Not connected");

  const meta = directionMeta();
  const rpc = (meta.from.chainId === CHAINS.LINEA.chainId) ? $("rpcLinea").value.trim() : $("rpcBase").value.trim();
  if (!rpc) {
    log(`Simulate failed: No Debug RPC URL set for ${meta.from.name}.`);
    return;
  }

  const q = await quote();

  // We simulate what we will call:
  // - Linea->Base: adapter.send(...)
  // - Base->Linea: router.send(...)
  const iface = new ethers.Interface(meta.senderType === "ROUTER" ? ROUTER_ABI : OFT_ABI);
  const data = iface.encodeFunctionData("send", [q.sendParam, { nativeFee: q.nativeFee, lzTokenFee: 0n }, userAddress]);

  const callTo = meta.sender; // actual sender contract
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [
      {
        to: callTo,
        from: userAddress,
        data,
        value: ethers.toBeHex(q.nativeFee)
      },
      "latest"
    ]
  };

  log(`SIMULATE (Debug RPC): ${meta.from.name} send() on ${callTo}`);

  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
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

    log(`eth_call OK (no revert).`);
  } catch (e) {
    log(`Simulate failed: ${e?.message || e}`);
  }
}

// ========= Wire up UI =========
$("btnConnect").onclick = () => connect().catch(e => log(`Connect failed: ${e?.message || e}`));
$("btnSwitchLinea").onclick = () => switchNetwork(CHAINS.LINEA.chainId).catch(e => log(`Switch failed: ${e?.message || e}`));
$("btnSwitchBase").onclick = () => switchNetwork(CHAINS.BASE.chainId).catch(e => log(`Switch failed: ${e?.message || e}`));

$("btnRefresh").onclick = () => refreshAll();
$("btnQuote").onclick = () => quote().catch(() => {});
$("btnApprove").onclick = () => quote().then(q => approveIfNeeded(q)).catch(() => {});
$("btnSend").onclick = () => send().catch(() => {});
$("btnSimulate").onclick = () => simulateViaDebugRPC().catch(() => {});
$("btnClear").onclick = () => { logEl.textContent = ""; };

$("direction").onchange = () => {
  $("feeLine").textContent = "—";
  refreshAll();
};

window.addEventListener("load", () => {
  $("spenderLine").textContent = "—";
  $("senderLine").textContent = "—";
  $("peerLine").textContent = "—";
  $("feeLine").textContent = "—";
  log(`Ready. Click "Connect Wallet".`);
});
