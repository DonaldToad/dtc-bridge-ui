import { ethers } from "https://esm.sh/ethers@6.13.4";
import { Options } from "https://esm.sh/@layerzerolabs/lz-v2-utilities@3.0.85";

// ========= YOUR CONSTANTS =========
const ADDRS = {
  // Base
  BASE_OFT: "0xFbA669C72b588439B29F050b93500D8b645F9354",
  BASE_ROUTER: "0x480C0d523511dd96A65A38f36aaEF69aC2BaA82a",

  // Linea
  LINEA_ADAPTER: "0x54B4E88E9775647614440Acc8B13A079277fa2A6",
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

// OFT / Adapter quote+send+peer (OFT v2 style)
const OFT_ABI = [
  "function peer(uint32 dstEid) view returns (bytes32)",
  "function quoteSend((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) p, bool payInLzToken) view returns (uint256 nativeFee, uint256 lzTokenFee)",
  "function send((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) p, (uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress) payable returns (bytes32 guid, uint64 nonce, (uint256 amountSentLD,uint256 amountReceivedLD) receipt)",
];

// Router only needs send (many routers don’t expose quoteSend)
const ROUTER_ABI = [
  "function send((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) p, (uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress) payable",
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
  const bps = Math.max(0, Math.min(100, slip)) * 100; // 0..10000
  const keepBps = 10000 - Math.round(bps);
  return (amountBN * BigInt(keepBps)) / 10000n;
}

function buildOptionsBytes(lzGas) {
  const gas = Number(lzGas);
  if (!Number.isFinite(gas) || gas <= 0) throw new Error("Invalid dst gas");
  // This prevents the InvalidWorkerId(0x6780cfaf) class of issues:
  return Options.newOptions().addExecutorLzReceiveOption(gas, 0).toBytes();
}

// ========= Provider state =========
let browserProvider = null;
let signer = null;
let userAddress = null;

function requireEthereum() {
  if (!window.ethereum) {
    alert("MetaMask not found. Install MetaMask and refresh.");
    throw new Error("No window.ethereum");
  }
  return window.ethereum;
}

async function initProviderAndSigner() {
  const eth = requireEthereum();
  browserProvider = new ethers.BrowserProvider(eth);
  signer = await browserProvider.getSigner();
  userAddress = await signer.getAddress();
  $("walletLine").textContent = `Connected: ${short(userAddress)} (${userAddress})`;
}

function installChainListeners() {
  const eth = requireEthereum();

  // Don’t hard reload; just re-init provider/signer and keep logs
  eth.removeAllListeners?.("chainChanged");
  eth.on?.("chainChanged", async () => {
    try {
      log("Network changed. Re-initializing provider...");
      await initProviderAndSigner();
      await refreshAll();
    } catch (e) {
      log(`Re-init after chainChanged failed: ${e?.message || e}`);
    }
  });

  eth.removeAllListeners?.("accountsChanged");
  eth.on?.("accountsChanged", async (accs) => {
    if (!accs || !accs.length) return;
    try {
      log("Account changed. Re-initializing provider...");
      await initProviderAndSigner();
      await refreshAll();
    } catch (e) {
      log(`Re-init after accountsChanged failed: ${e?.message || e}`);
    }
  });
}

async function getChainId() {
  const net = await browserProvider.getNetwork();
  return Number(net.chainId);
}

function getDirection() {
  return $("direction").value;
}

/**
 * IMPORTANT FIX:
 * - Linea→Base: quote+send on Linea Adapter, approve Adapter to spend canonical token.
 * - Base→Linea: quote on Base OFT, BUT send on Base Router, approve Router to spend OFT.
 */
function directionMeta() {
  const dir = getDirection();

  if (dir === "LINEA_TO_BASE") {
    return {
      from: CHAINS.LINEA,
      to: CHAINS.BASE,

      // token you hold/spend on Linea
      token: ADDRS.DTC_LINEA,
      spender: ADDRS.LINEA_ADAPTER,

      // quote+send contract
      quoteContract: ADDRS.LINEA_ADAPTER,
      sendContract: ADDRS.LINEA_ADAPTER,

      peerReader: ADDRS.LINEA_ADAPTER, // has peer()
    };
  }

  // BASE_TO_LINEA
  return {
    from: CHAINS.BASE,
    to: CHAINS.LINEA,

    // token you hold/spend on Base
    token: ADDRS.BASE_OFT,
    spender: ADDRS.BASE_ROUTER, // approve ROUTER (not OFT)

    // quote on OFT, send on ROUTER
    quoteContract: ADDRS.BASE_OFT,
    sendContract: ADDRS.BASE_ROUTER,

    peerReader: ADDRS.BASE_OFT, // peer() usually on OFT (not router)
  };
}

async function switchNetwork(chainIdDec) {
  const eth = requireEthereum();
  const hex = "0x" + chainIdDec.toString(16);
  log(`Switching network to chainId=${chainIdDec}...`);

  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    const msg = String(e?.message || "");
    if (e?.code === 4902 || msg.includes("Unrecognized chain") || msg.includes("not been added")) {
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

async function readPeer(peerReaderAddr, dstEid) {
  const c = new ethers.Contract(peerReaderAddr, OFT_ABI, browserProvider);
  const peerBytes32 = await c.peer(dstEid);
  const asAddr = ethers.getAddress("0x" + peerBytes32.slice(26));
  return { peerBytes32, asAddr };
}

function buildSendParam(meta, amount, minAmount, extraOptions) {
  return {
    dstEid: meta.to.eid,
    to: toBytes32Address(userAddress),
    amountLD: amount,
    minAmountLD: minAmount,
    extraOptions: ethers.hexlify(extraOptions),
    composeMsg: "0x",
    oftCmd: "0x",
  };
}

async function quote() {
  const meta = directionMeta();
  const chainId = await getChainId();

  if (chainId !== meta.from.chainId) {
    log(`Wrong network. Switching to ${meta.from.name}...`);
    await switchNetwork(meta.from.chainId);
    return null;
  }

  const { token, sym, dec } = await getTokenMeta(meta.token);

  const amountStr = $("amount").value.trim();
  const slipStr = $("slippage").value.trim();
  const lzGas = $("lzGas").value.trim();

  const amount = parseAmount(amountStr, dec);
  const minAmount = percentToMin(amount, slipStr);
  const extraOptions = buildOptionsBytes(lzGas);

  const sendParam = buildSendParam(meta, amount, minAmount, extraOptions);

  // peer sanity
  const peer = await readPeer(meta.peerReader, meta.to.eid);
  $("peerLine").textContent = `${peer.asAddr} (bytes32: ${peer.peerBytes32})`;
  log(`Diag: peer=${peer.asAddr}`);

  // quote on quoteContract (OFT or Adapter)
  const quoteC = new ethers.Contract(meta.quoteContract, OFT_ABI, browserProvider);

  log(`Quote: ${meta.from.name} → ${meta.to.name} quoteOn=${meta.quoteContract} amount=${amountStr} min=${formatAmount(minAmount, dec)} ${sym}`);

  const res = await quoteC.quoteSend(sendParam, false);
  const nativeFee = res[0];
  const lzTokenFee = res[1];

  $("feeLine").textContent = `${ethers.formatEther(nativeFee)} ${meta.from.currency}`;
  $("spenderLine").textContent = meta.spender;
  $("senderLine").textContent = meta.sendContract;

  log(`Native fee: ${ethers.formatEther(nativeFee)} ${meta.from.currency}`);
  return { meta, token, sym, dec, amountStr, amount, minAmount, sendParam, nativeFee, lzTokenFee };
}

async function approveIfNeeded(q) {
  const meta = q.meta;
  const chainId = await getChainId();
  if (chainId !== meta.from.chainId) {
    log(`Wrong network. Switching to ${meta.from.name}...`);
    await switchNetwork(meta.from.chainId);
    return false;
  }

  const token = q.token;
  const allowance = await token.allowance(userAddress, meta.spender);

  if (allowance >= q.amount) {
    log(`Approve not needed. allowance=${formatAmount(allowance, q.dec)} ${q.sym}`);
    return true;
  }

  const tokenWithSigner = token.connect(signer);
  log(`Approving spender=${meta.spender} for ${q.amountStr} ${q.sym}...`);
  const tx = await tokenWithSigner.approve(meta.spender, q.amount);
  log(`Approve tx: ${tx.hash}`);
  await tx.wait();
  log(`Approve confirmed.`);
  return true;
}

async function send() {
  const q = await quote();
  if (!q) return;

  await approveIfNeeded(q);

  const meta = q.meta;

  // fee struct
  const fee = { nativeFee: q.nativeFee, lzTokenFee: 0n };

  log(`Sending via sendOn=${meta.sendContract} with msg.value=${ethers.formatEther(q.nativeFee)} ${meta.from.currency}...`);

  try {
    if (getDirection() === "BASE_TO_LINEA") {
      // IMPORTANT FIX: send on ROUTER
      const router = new ethers.Contract(meta.sendContract, ROUTER_ABI, signer);
      const tx = await router.send(q.sendParam, fee, userAddress, { value: q.nativeFee });
      log(`Send tx: ${tx.hash}`);
      const rcpt = await tx.wait();
      log(`Send confirmed (source chain). status=${rcpt.status}. Delivery is async.`);
      return;
    }

    // LINEA_TO_BASE: send on ADAPTER
    const sender = new ethers.Contract(meta.sendContract, OFT_ABI, signer);
    const tx = await sender.send(q.sendParam, fee, userAddress, { value: q.nativeFee });
    log(`Send tx: ${tx.hash}`);
    const rcpt = await tx.wait();
    log(`Send confirmed (source chain). status=${rcpt.status}. Delivery is async.`);
  } catch (e) {
    log(`Send failed: ${e?.shortMessage || e?.message || e}`);
    log(`If it says "missing revert data", use Simulate with Debug RPC to extract selector + args.`);
  }
}

async function refreshAll() {
  if (!browserProvider || !signer || !userAddress) return;

  const meta = directionMeta();
  const chainId = await getChainId();
  $("netLine").textContent = `Network: ${chainId}`;
  $("spenderLine").textContent = meta.spender;
  $("senderLine").textContent = meta.sendContract;

  // IMPORTANT FIX: only read token meta on the chain where the token exists
  if (chainId !== meta.from.chainId) {
    $("balLine").textContent = `Balance: — (switch to ${meta.from.name})`;
    $("peerLine").textContent = `— (switch to ${meta.from.name} to read peer)`;
    return;
  }

  try {
    const { token, sym, dec } = await getTokenMeta(meta.token);
    const bal = await token.balanceOf(userAddress);
    $("balLine").textContent = `Balance: ${formatAmount(bal, dec)} ${sym}`;

    const allowance = await token.allowance(userAddress, meta.spender);
    log(`Diag: chain=${meta.from.name} balance=${formatAmount(bal, dec)} ${sym} allowance=${formatAmount(allowance, dec)} ${sym}`);

    const peer = await readPeer(meta.peerReader, meta.to.eid);
    $("peerLine").textContent = `${peer.asAddr} (bytes32: ${peer.peerBytes32})`;
  } catch (e) {
    log(`Refresh error: ${e?.shortMessage || e?.message || e}`);
  }
}

// ===== Debug simulation =====
async function simulateViaDebugRPC() {
  const meta = directionMeta();
  const chainId = await getChainId();

  if (chainId !== meta.from.chainId) {
    log(`Simulate: wrong network. Switch to ${meta.from.name} first.`);
    return;
  }

  const rpc = (meta.from.chainId === CHAINS.LINEA.chainId) ? $("rpcLinea").value.trim() : $("rpcBase").value.trim();
  if (!rpc) {
    log(`Simulate failed: No Debug RPC URL set for ${meta.from.name}.`);
    return;
  }

  const q = await quote();
  if (!q) return;

  // encode call for whichever contract we actually send on
  let to, iface, data;

  if (getDirection() === "BASE_TO_LINEA") {
    to = meta.sendContract; // router
    iface = new ethers.Interface(ROUTER_ABI);
    data = iface.encodeFunctionData("send", [q.sendParam, { nativeFee: q.nativeFee, lzTokenFee: 0n }, userAddress]);
  } else {
    to = meta.sendContract; // adapter
    iface = new ethers.Interface(OFT_ABI);
    data = iface.encodeFunctionData("send", [q.sendParam, { nativeFee: q.nativeFee, lzTokenFee: 0n }, userAddress]);
  }

  log(`SIMULATE (Debug RPC): ${meta.from.name} call to ${to}`);
  log(`  rpc=${rpc}`);
  log(`  from=${userAddress}`);
  log(`  value=${ethers.formatEther(q.nativeFee)} ETH`);

  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [
      { to, from: userAddress, data, value: ethers.toBeHex(q.nativeFee) },
      "latest",
    ],
  };

  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();

    if (json.error) {
      const errData = json.error?.data;
      log(`eth_call reverted. message=${json.error?.message || "—"}`);
      if (typeof errData === "string" && errData.startsWith("0x")) {
        log(`FOUND revert hex: ${errData}`);
        log(`selector: ${errData.slice(0, 10)}`);
      } else {
        log(`No revert hex. Full error: ${JSON.stringify(json.error)}`);
      }
      return;
    }

    log(`eth_call OK (no revert). result=${String(json.result || "").slice(0, 66)}`);
  } catch (e) {
    log(`Simulate failed: ${e?.message || e}`);
  }
}

// ========= Connect =========
async function connect() {
  const eth = requireEthereum();
  installChainListeners();
  await eth.request({ method: "eth_requestAccounts" });
  await initProviderAndSigner();
  log(`Connected: ${userAddress}`);
  await refreshAll();
}

// ========= Wire up UI =========
$("btnConnect").onclick = () => connect().catch(e => log(`Connect failed: ${e?.message || e}`));
$("btnSwitchLinea").onclick = () => switchNetwork(CHAINS.LINEA.chainId).catch(e => log(`Switch failed: ${e?.message || e}`));
$("btnSwitchBase").onclick = () => switchNetwork(CHAINS.BASE.chainId).catch(e => log(`Switch failed: ${e?.message || e}`));

$("btnRefresh").onclick = () => refreshAll();
$("btnQuote").onclick = () => quote().catch(e => log(`Quote failed: ${e?.shortMessage || e?.message || e}`));
$("btnApprove").onclick = async () => {
  try {
    const q = await quote();
    if (q) await approveIfNeeded(q);
  } catch (e) {
    log(`Approve flow failed: ${e?.message || e}`);
  }
};
$("btnSend").onclick = () => send().catch(e => log(`Send flow failed: ${e?.message || e}`));
$("btnSimulate").onclick = () => simulateViaDebugRPC().catch(e => log(`Simulate flow failed: ${e?.message || e}`));
$("btnClear").onclick = () => { logEl.textContent = ""; };

$("direction").onchange = () => {
  $("feeLine").textContent = "—";
  refreshAll();
};

window.addEventListener("load", () => {
  $("walletLine").textContent = "Not connected";
  $("spenderLine").textContent = "—";
  $("senderLine").textContent = "—";
  $("peerLine").textContent = "—";
  $("feeLine").textContent = "—";
  $("balLine").textContent = "Balance: —";
  $("netLine").textContent = "Network: —";
  log(`Ready. Click "Connect Wallet".`);
});
