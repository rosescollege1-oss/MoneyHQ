import { firebaseConfig } from "./firebase-config.js";

const FIREBASE_VERSION = "12.19.0";
const COLLECTIONS = ["accounts","transactions","bills","billPayments","debts","incomeSchedules","settings","reviewFlags"];
const $ = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => [...el.querySelectorAll(s)];
const money = n => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(n||0));
const todayISO = () => new Date().toISOString().slice(0,10);
const monthKey = (d=new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
const fmtDate = s => s ? new Date(`${s}T12:00:00`).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : "";
const fmtTransactionDate = t => t?.monthOnly && t?.date
  ? new Date(`${t.date}T12:00:00`).toLocaleDateString("en-US",{month:"short",year:"numeric"})
  : fmtDate(t?.date);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

const DEFAULT_CATEGORIES = [
  "Housing","Utilities","Groceries","Dining Out","Gas","Transportation","Insurance",
  "Medical","Pets","Shopping","Entertainment","Subscriptions","Debt Payment","Income","Transfer","Other"
];

const firebaseReady = firebaseConfig?.apiKey && !firebaseConfig.apiKey.includes("PASTE_");
let mode = firebaseReady ? "firebase" : "local";
let fb = {};
let currentUser = null;
let unsubscribers = [];
let state = {
  accounts:[], transactions:[], bills:[], billPayments:[], debts:[], incomeSchedules:[], reviewFlags:[],
  settings:[{id:"main",reserveAmount:0}]
};

function toast(msg){
  const el=$("#toast"); el.textContent=msg; el.classList.add("show");
  clearTimeout(window.__toast); window.__toast=setTimeout(()=>el.classList.remove("show"),2600);
}
function escapeHTML(v=""){return String(v).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[m]));}
function num(v){return Number(v||0);}
function signedTransactionAmount(type, amount){
  amount=Math.abs(num(amount));
  return type==="income" || type==="refund" ? amount : type==="expense" ? -amount : amount;
}
function accountName(id){return state.accounts.find(x=>x.id===id)?.name || "—";}
function getSettings(){return state.settings.find(x=>x.id==="main") || {reserveAmount:0};}
function collectionStateName(name){return name;}

class LocalStore{
  constructor(){this.prefix="moneyhq:";}
  async start(){
    COLLECTIONS.forEach(c=>{
      const raw=localStorage.getItem(this.prefix+c);
      if(raw) state[collectionStateName(c)] = JSON.parse(raw);
    });
    if(!state.settings?.length) state.settings=[{id:"main",reserveAmount:0}];
    renderAll();
  }
  persist(c){localStorage.setItem(this.prefix+c,JSON.stringify(state[collectionStateName(c)]));}
  async save(c,data){
    const arr=state[collectionStateName(c)];
    const item={...data,id:data.id||uid(),updatedAt:new Date().toISOString()};
    const i=arr.findIndex(x=>x.id===item.id);
    if(i>=0) arr[i]=item; else arr.push(item);
    this.persist(c); renderAll(); return item;
  }
  async remove(c,id){
    state[collectionStateName(c)] = state[collectionStateName(c)].filter(x=>x.id!==id);
    this.persist(c); renderAll();
  }
}
let store = new LocalStore();

async function initFirebase(){
  const appMod = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`);
  const authMod = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth.js`);
  const fsMod = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-firestore.js`);
  const app=appMod.initializeApp(firebaseConfig);
  const auth=authMod.getAuth(app);
  const db=fsMod.getFirestore(app);
  fb={appMod,authMod,fsMod,app,auth,db};

  $("#modeBadge").textContent="Firebase • secure household login";
  $("#signOutBtn").classList.remove("hidden");
  $("#dataModeText").textContent="Your data is stored in Cloud Firestore under your signed-in Firebase user ID. The included security rules block every other user.";

  authMod.onAuthStateChanged(auth, async user=>{
    currentUser=user;
    if(!user){
      stopListeners();
      $("#authScreen").classList.remove("hidden");
      $("#appShell").classList.add("hidden");
      return;
    }
    $("#authScreen").classList.add("hidden");
    $("#appShell").classList.remove("hidden");
    startFirebaseListeners(user.uid);
  });
}
function stopListeners(){unsubscribers.forEach(fn=>fn());unsubscribers=[];}
function startFirebaseListeners(userId){
  stopListeners();
  COLLECTIONS.forEach(c=>{
    const ref=fb.fsMod.collection(fb.db,"users",userId,c);
    const unsub=fb.fsMod.onSnapshot(ref,snap=>{
      state[collectionStateName(c)] = snap.docs.map(d=>({id:d.id,...d.data()}));
      if(c==="settings" && !state.settings.length) state.settings=[{id:"main",reserveAmount:0}];
      renderAll();
    },err=>toast(`Firebase error: ${err.message}`));
    unsubscribers.push(unsub);
  });
  store={
    async save(c,data){
      const id=data.id||uid(); const ref=fb.fsMod.doc(fb.db,"users",currentUser.uid,c,id);
      const clean=JSON.parse(JSON.stringify({...data,id,updatedAt:new Date().toISOString()}));
      await fb.fsMod.setDoc(ref,clean,{merge:true}); return clean;
    },
    async remove(c,id){
      await fb.fsMod.deleteDoc(fb.fsMod.doc(fb.db,"users",currentUser.uid,c,id));
    }
  };
}

function computedAccountBalance(account){
  return num(account.openingBalance) + state.transactions
    .filter(t=>t.accountId===account.id)
    .reduce((s,t)=>s+num(t.amount),0);
}
async function setLinkedDebtFromProjected(accountId,projectedBalance){
  const account=state.accounts.find(a=>a.id===accountId);
  if(!account || account.type!=="credit") return;
  const debt=state.debts.find(d=>d.accountId===accountId);
  if(!debt) return;
  await store.save("debts",{...debt,balance:Math.abs(num(projectedBalance))});
}
function cashTotal(){
  return state.accounts.filter(a=>a.includeInSafeToSpend===true)
    .reduce((sum,a)=>sum+computedAccountBalance(a),0);
}
function paymentKey(billId,mk){return `${billId}_${mk}`;}
function isBillPaid(bill,mk=monthKey()){
  return state.billPayments.some(p=>p.billId===bill.id && p.month===mk);
}
function dueDateForMonth(bill,mk=monthKey()){
  if(bill.dueDay===null || bill.dueDay===undefined || bill.dueDay==="" || num(bill.dueDay)<1) return null;
  const [y,m]=mk.split("-").map(Number);
  const last=new Date(y,m,0).getDate();
  const day=Math.min(num(bill.dueDay),last);
  return `${y}-${String(m).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}
function nextBillOccurrence(bill, from=new Date()){
  let y=from.getFullYear(), m=from.getMonth()+1;
  let mk=`${y}-${String(m).padStart(2,"0")}`;
  let due=dueDateForMonth(bill,mk);
  if(!due) return {month:mk,date:null};
  if(isBillPaid(bill,mk) || new Date(`${due}T23:59:59`) < new Date(from.toDateString())){
    const d=new Date(y,m,1); y=d.getFullYear();m=d.getMonth()+1;mk=`${y}-${String(m).padStart(2,"0")}`;due=dueDateForMonth(bill,mk);
  }
  return {month:mk,date:due};
}
function advanceDate(dateStr,frequency){
  const d=new Date(`${dateStr}T12:00:00`);
  if(frequency==="weekly") d.setDate(d.getDate()+7);
  else if(frequency==="biweekly") d.setDate(d.getDate()+14);
  else if(frequency==="monthly") d.setMonth(d.getMonth()+1);
  else if(frequency==="semimonthly") d.setDate(d.getDate()+15);
  else d.setMonth(d.getMonth()+1);
  return d.toISOString().slice(0,10);
}
function nextIncomeDate(){
  const dates=state.incomeSchedules.filter(i=>i.active!==false && i.nextDate)
    .map(i=>i.nextDate).filter(d=>d>=todayISO()).sort();
  return dates[0]||null;
}
function billsDueThrough(dateStr){
  if(!dateStr) return [];
  const end=new Date(`${dateStr}T23:59:59`);
  const now=new Date(`${todayISO()}T00:00:00`);
  const out=[];
  state.bills.filter(b=>b.active!==false).forEach(b=>{
    // inspect this month + next 2 months
    for(let offset=0;offset<3;offset++){
      const d=new Date(now.getFullYear(),now.getMonth()+offset,1);
      const mk=monthKey(d), due=dueDateForMonth(b,mk);
      if(!due) continue;
      const dueD=new Date(`${due}T12:00:00`);
      if(dueD>=now && dueD<=end && !isBillPaid(b,mk)) out.push({...b,_month:mk,_due:due});
    }
  });
  return out;
}
function monthTransactions(mk=monthKey()){
  return state.transactions.filter(t=>(t.date||"").slice(0,7)===mk && t.type!=="transfer");
}
function setText(id,v){const el=$(id); if(el) el.textContent=v;}
function empty(msg){return `<div class="empty">${escapeHTML(msg)}</div>`;}

function renderDashboard(){
  const cash=cashTotal(), payday=nextIncomeDate(), before=billsDueThrough(payday).reduce((s,b)=>s+num(b.amount),0);
  const reserve=num(getSettings().reserveAmount), safe=cash-before-reserve;
  const debt=state.debts.reduce((sum,d)=>sum+num(d.balance),0);
  const knownMinimums=state.debts.filter(d=>d.minimumPayment!==null&&d.minimumPayment!==undefined&&d.minimumPayment!=="");
  const minimums=knownMinimums.reduce((sum,d)=>sum+num(d.minimumPayment),0);
  setText("#safeToSpend",money(safe)); setText("#cashAvailable",money(cash)); setText("#billsBeforePayday",money(before));
  setText("#nextPaydayText",payday?`through ${fmtDate(payday)}`:"Add an income schedule");
  setText("#safeToSpendDetail",`${money(before)} bills + ${money(reserve)} protected`);
  setText("#totalDebt",money(debt)); setText("#debtDetail",knownMinimums.length===state.debts.length?`${money(minimums)} minimums / month`:`${knownMinimums.length} of ${state.debts.length} minimums entered`);

  const tx=monthTransactions();
  const inc=tx.filter(t=>t.type==="income").reduce((sum,t)=>sum+Math.max(0,num(t.amount)),0);
  const grossSpend=Math.abs(tx.filter(t=>t.type==="expense"&&num(t.amount)<0).reduce((sum,t)=>sum+num(t.amount),0));
  const refunds=tx.filter(t=>t.type==="refund"&&num(t.amount)>0).reduce((sum,t)=>sum+num(t.amount),0);
  const spent=Math.max(0,grossSpend-refunds);
  setText("#monthIncome",money(inc));setText("#monthSpent",money(spent));setText("#monthNet",money(inc-spent));

  const currentMK=monthKey();
  const attention=[];
  state.bills.filter(b=>b.active!==false && !isBillPaid(b,currentMK)).forEach(b=>{
    const due=dueDateForMonth(b,currentMK);
    const late=!!due && due<todayISO();
    attention.push({...b,_due:due,_late:late});
  });
  attention.sort((a,b)=>(a._due||"9999").localeCompare(b._due||"9999"));
  $("#attentionBills").innerHTML=attention.length?attention.slice(0,6).map(b=>`
    <div class="list-row"><div class="list-main"><strong>${escapeHTML(b.name)}</strong>
    <span>${!b._due?"SET DUE DAY":`${b._late?"OVERDUE • ":""}Due ${fmtDate(b._due)}`}</span></div>
    <span class="amount ${b._late?"negative":""}">${money(b.amount)}</span></div>`).join(""):empty("Nothing is waiting for payment this month.");

  const recent=[...state.transactions].sort((a,b)=>(b.date||"").localeCompare(a.date||"")).slice(0,7);
  $("#recentTransactions").innerHTML=recent.length?recent.map(t=>`
    <div class="list-row"><div class="list-main"><strong>${escapeHTML(t.payee||"Transaction")}</strong>
    <span>${fmtTransactionDate(t)} • ${escapeHTML(t.category||"Uncategorized")}</span></div>
    <span class="amount ${num(t.amount)<0?"negative":"positive"}">${money(t.amount)}</span></div>`).join(""):empty("No transactions yet.");

  const debts=[...state.debts].sort((a,b)=>num(b.balance)-num(a.balance)).slice(0,6);
  $("#debtSnapshot").innerHTML=debts.length?debts.map(d=>`
    <div class="list-row"><div class="list-main"><strong>${escapeHTML(d.name)}</strong>
    <span>${d.apr===null||d.apr===undefined?"APR needed":`${num(d.apr).toFixed(2)}% APR`} • ${d.minimumPayment===null||d.minimumPayment===undefined?"minimum needed":`min ${money(d.minimumPayment)}`}</span></div>
    <span class="amount">${money(d.balance)}</span></div>`).join(""):empty("Add debts when you're ready. Seeing the total is the first step.");

  $("#setupNotice").classList.toggle("hidden",state.accounts.length>0 || state.bills.length>0 || state.debts.length>0);
}
function renderLedger(){
  const af=$("#ledgerAccountFilter"), current=af.value;
  af.innerHTML=`<option value="">All accounts</option>`+state.accounts.map(a=>`<option value="${a.id}">${escapeHTML(a.name)}</option>`).join("");
  af.value=current;
  const q=$("#ledgerSearch").value.toLowerCase().trim(), acc=af.value, mk=$("#ledgerMonth").value;
  let rows=[...state.transactions].filter(t=>{
    const hay=`${t.payee||""} ${t.note||""} ${t.category||""}`.toLowerCase();
    return (!q||hay.includes(q)) && (!acc||t.accountId===acc) && (!mk||(t.date||"").startsWith(mk));
  }).sort((a,b)=>(b.date||"").localeCompare(a.date||"") || (b.updatedAt||"").localeCompare(a.updatedAt||""));
  $("#transactionTable").innerHTML=rows.length?rows.map(t=>`<tr>
    <td>${fmtTransactionDate(t)}</td><td><strong>${escapeHTML(t.payee||"")}</strong>${t.note?`<div class="tiny muted">${escapeHTML(t.note)}</div>`:""}</td>
    <td>${escapeHTML(t.category||"")}</td><td>${escapeHTML(accountName(t.accountId))}</td>
    <td class="right amount ${num(t.amount)<0?"negative":"positive"}">${money(t.amount)}</td>
    <td class="right"><button class="text-btn" data-edit-tx="${t.id}">Edit</button></td></tr>`).join(""):`<tr><td colspan="6">${empty("No matching transactions.")}</td></tr>`;
}
function renderBills(){
  const mk=monthKey();
  const active=state.bills.filter(b=>b.active!==false);
  const monthly=active.reduce((sum,b)=>sum+num(b.amount),0);
  const unpaid=active.filter(b=>!isBillPaid(b,mk));
  const overdue=unpaid.filter(b=>{const due=dueDateForMonth(b,mk);return !!due&&due<todayISO();});
  const paid=active.filter(b=>isBillPaid(b,mk));
  setText("#monthlyBills",money(monthly));setText("#billsStillDue",money(unpaid.reduce((sum,b)=>sum+num(b.amount),0)));
  setText("#overdueBills",money(overdue.reduce((sum,b)=>sum+num(b.amount),0)));setText("#paidBills",money(paid.reduce((sum,b)=>sum+num(b.amount),0)));
  const sorted=[...active].sort((a,b)=>(num(a.dueDay)||99)-(num(b.dueDay)||99));
  $("#billList").innerHTML=sorted.length?sorted.map(b=>{
    const paidNow=isBillPaid(b,mk), due=dueDateForMonth(b,mk), late=!paidNow&&!!due&&due<todayISO(), missing=!due;
    const badge=paidNow?"PAID":missing?"SET DUE DAY":late?"OVERDUE":"UPCOMING";
    return `<article class="card">
      <div class="card-top"><div><h3>${escapeHTML(b.name)}</h3><div class="sub">${missing?"Due day needs review":`Due day ${b.dueDay}`}${b.autopay?" • Autopay":""}</div></div>
      <span class="pill ${late||missing?"bad":paidNow?"":"warn"}">${badge}</span></div>
      <div class="big-number">${money(b.amount)}${b.amountEstimated?"*":""}</div>
      <div class="sub">${b.amountEstimated?"*Imported estimate • ":""}${escapeHTML(b.category||"Bill")} • ${escapeHTML(accountName(b.accountId))}</div>
      <div class="card-actions">
        ${paidNow?`<button class="secondary" data-unpay-bill="${b.id}">Undo paid</button>`:`<button class="primary" data-pay-bill="${b.id}">Mark paid</button>`}
        <button class="secondary" data-edit-bill="${b.id}">${missing?"Finish setup":"Edit"}</button>
      </div>
    </article>`;
  }).join(""):empty("No bills yet. Add every recurring bill, even the annoying tiny ones.");
}
function renderDebts(){
  const total=state.debts.reduce((sum,d)=>sum+num(d.balance),0);
  const knownMins=state.debts.filter(d=>d.minimumPayment!==null&&d.minimumPayment!==undefined&&d.minimumPayment!=="");
  const mins=knownMins.reduce((sum,d)=>sum+num(d.minimumPayment),0);
  const knownApr=state.debts.filter(d=>d.apr!==null&&d.apr!==undefined&&d.apr!=="");
  const interest=knownApr.reduce((sum,d)=>sum+num(d.balance)*(num(d.apr)/100)/12,0);
  const highest=knownApr.length?Math.max(...knownApr.map(d=>num(d.apr))):null;
  setText("#debtTotal2",money(total));
  setText("#minimumTotal",`${money(mins)}${knownMins.length<state.debts.length?"+":""}`);
  setText("#interestTotal",knownApr.length?`${money(interest)}${knownApr.length<state.debts.length?"+":""}`:"Needs APRs");
  setText("#highestApr",highest===null?"Needs APRs":`${highest.toFixed(2)}%`);
  const sorted=[...state.debts].sort((a,b)=>num(b.balance)-num(a.balance));
  $("#debtList").innerHTML=sorted.length?sorted.map(d=>{
    const util=d.limit?Math.min(100,num(d.balance)/num(d.limit)*100):null;
    const aprKnown=d.apr!==null&&d.apr!==undefined&&d.apr!=="";
    const minKnown=d.minimumPayment!==null&&d.minimumPayment!==undefined&&d.minimumPayment!=="";
    return `<article class="card">
      <div class="card-top"><div><h3>${escapeHTML(d.name)}</h3><div class="sub">${escapeHTML(d.type||"Debt")}${d.owner?` • ${escapeHTML(d.owner)}`:""} • ${d.dueDay?`due day ${d.dueDay}`:"due day needed"}</div></div><span class="pill ${aprKnown?"":"bad"}">${aprKnown?`${num(d.apr).toFixed(2)}% APR`:"APR NEEDED"}</span></div>
      <div class="big-number">${money(d.balance)}</div>
      ${util!==null?`<div class="sub">${util.toFixed(1)}% utilization of ${money(d.limit)}</div><div class="progress"><i style="width:${util}%"></i></div>`:""}
      <div class="mini-grid"><div><span>Minimum</span><strong>${minKnown?money(d.minimumPayment):"NEEDED"}</strong></div><div><span>Est. interest/mo</span><strong>${aprKnown?money(num(d.balance)*(num(d.apr)/100)/12):"—"}</strong></div></div>
      <div class="card-actions"><button class="primary" data-pay-debt="${d.id}">Record payment</button><button class="secondary" data-edit-debt="${d.id}">${d.needsReview?"Finish setup":"Edit"}</button></div>
    </article>`;
  }).join(""):empty("Add each debt separately. No judgment, just clean numbers.");
}
function renderAccounts(){
  const sorted=[...state.accounts].sort((a,b)=>a.name.localeCompare(b.name));
  $("#accountList").innerHTML=sorted.length?sorted.map(a=>{
    const bal=computedAccountBalance(a), isCredit=a.type==="credit";
    const badge=a.includeInSafeToSpend===true?"SAFE-TO-SPEND":isCredit?"CREDIT":"TRACKED";
    return `<article class="card">
      <div class="card-top"><div><h3>${escapeHTML(a.name)}</h3><div class="sub">${escapeHTML(a.type)}${a.owner?` • ${escapeHTML(a.owner)}`:""}</div></div><span class="pill">${badge}</span></div>
      <div class="big-number">${isCredit?`${money(Math.abs(bal))} owed`:money(bal)}</div><div class="sub">Starting balance ${money(a.openingBalance)} • ${state.transactions.filter(t=>t.accountId===a.id).length} entries</div>
      <div class="card-actions">${isCredit?"":`<button class="secondary" data-reconcile="${a.id}">Reconcile</button>`}<button class="secondary" data-edit-account="${a.id}">Edit</button></div>
    </article>`;
  }).join(""):empty("Start here: add each checking, savings, or cash account with today's real balance.");
}
function renderIncome(){
  const sorted=[...state.incomeSchedules].sort((a,b)=>(a.nextDate||"").localeCompare(b.nextDate||""));
  $("#incomeList").innerHTML=sorted.length?sorted.map(i=>`<article class="card">
    <div class="card-top"><div><h3>${escapeHTML(i.name)}</h3><div class="sub">${escapeHTML(i.frequency)} • next ${fmtDate(i.nextDate)}</div></div><span class="pill">${i.active===false?"PAUSED":"EXPECTED"}</span></div>
    <div class="big-number">${money(i.amount)}</div><div class="sub">Deposit to ${escapeHTML(accountName(i.accountId))}</div>
    <div class="card-actions"><button class="primary" data-receive-income="${i.id}">Mark received</button><button class="secondary" data-edit-income="${i.id}">Edit</button></div>
  </article>`).join(""):empty("Add expected paychecks or regular income. This powers “Bills before payday.”");
}
function renderReports(){
  const mk=$("#reportMonth").value||monthKey(); const tx=monthTransactions(mk);
  const inc=tx.filter(t=>t.type==="income").reduce((sum,t)=>sum+Math.max(0,num(t.amount)),0);
  const grossExp=Math.abs(tx.filter(t=>t.type==="expense"&&num(t.amount)<0).reduce((sum,t)=>sum+num(t.amount),0));
  const refunds=tx.filter(t=>t.type==="refund"&&num(t.amount)>0).reduce((sum,t)=>sum+num(t.amount),0);
  const exp=Math.max(0,grossExp-refunds);
  setText("#reportIncome",money(inc));setText("#reportExpenses",money(exp));setText("#reportNet",money(inc-exp));setText("#reportCount",String(tx.length));
  const cats={};
  tx.filter(t=>t.type==="expense"&&num(t.amount)<0).forEach(t=>cats[t.category||"Uncategorized"]=(cats[t.category||"Uncategorized"]||0)+Math.abs(num(t.amount)));
  tx.filter(t=>t.type==="refund"&&num(t.amount)>0).forEach(t=>cats[t.category||"Refund"]=(cats[t.category||"Refund"]||0)-num(t.amount));
  const catRows=Object.entries(cats).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]); const max=catRows[0]?.[1]||1;
  $("#categoryReport").innerHTML=catRows.length?catRows.map(([c,v])=>`<div class="bar-row"><span>${escapeHTML(c)}</span><div class="bar-track"><div class="bar-fill" style="width:${v/max*100}%"></div></div><strong class="right">${money(v)}</strong></div>`).join(""):empty("No expenses in this month.");
  const merchants={};tx.filter(t=>t.type==="expense"&&num(t.amount)<0).forEach(t=>merchants[t.payee||"Unknown"]=(merchants[t.payee||"Unknown"]||0)+Math.abs(num(t.amount)));
  const mr=Object.entries(merchants).sort((a,b)=>b[1]-a[1]).slice(0,12);
  $("#merchantReport").innerHTML=mr.length?mr.map(([n,v])=>`<div class="list-row"><div class="list-main"><strong>${escapeHTML(n)}</strong></div><span class="amount">${money(v)}</span></div>`).join(""):empty("No spending to summarize.");
}
function renderSettings(){
  $("#reserveAmount").value=num(getSettings().reserveAmount).toFixed(2);
  if(mode==="local") $("#dataModeText").textContent="You are in local test mode. Data stays only in this browser. Add your Firebase configuration before entering real financial information you want synced across devices.";
  const flags=state.reviewFlags||[], list=$("#reviewFlagsList");
  if(list) list.innerHTML=flags.length?flags.map(f=>`<div class="list-row"><div class="list-main"><strong>${escapeHTML(f.type==="possible_duplicate"?"Possible duplicate from ledger":"Review item")}</strong><span>${escapeHTML(f.account||"")} ${f.category?`• ${escapeHTML(f.category)}`:""} ${f.amount!==undefined?`• ${money(f.amount)}`:""} ${f.rows?`• rows ${f.rows.join(", ")}`:""}</span></div></div>`).join(""):empty("No import review flags.");
  const status=$("#importStatus"); if(status&&state.transactions.length) status.textContent=`Current books: ${state.accounts.length} accounts • ${state.transactions.length.toLocaleString()} entries • ${state.debts.length} debts`;
}
function renderAll(){renderDashboard();renderLedger();renderBills();renderDebts();renderAccounts();renderIncome();renderReports();renderSettings();}

function showView(name){
  $$(".view").forEach(v=>v.classList.toggle("active",v.id===`${name}View`));
  $$("#nav button").forEach(b=>b.classList.toggle("active",b.dataset.view===name));
  const titles={dashboard:"Dashboard",ledger:"Checkbook",bills:"Bills",debts:"Debt Center",accounts:"Accounts",income:"Income",reports:"Reports",settings:"Settings"};
  setText("#viewTitle",titles[name]||"Money HQ");
  window.scrollTo({top:0,behavior:"smooth"});
}
function openModal(title,html,eyebrow="MONEY HQ"){
  setText("#modalTitle",title);setText("#modalEyebrow",eyebrow);$("#modalBody").innerHTML=html;$("#modal").showModal();
}
function closeModal(){$("#modal").close();}
function options(list,current="",label=x=>x.name){
  return list.map(x=>`<option value="${x.id}" ${x.id===current?"selected":""}>${escapeHTML(label(x))}</option>`).join("");
}
function accountOptions(current=""){return `<option value="">Choose account</option>${options(state.accounts,current)}`;}
function categoryOptions(current=""){
  const vals=[...new Set([...DEFAULT_CATEGORIES,...state.transactions.map(t=>t.category).filter(Boolean)])].sort();
  return vals.map(c=>`<option ${c===current?"selected":""}>${escapeHTML(c)}</option>`).join("");
}

function transactionForm(existing={}){
  const type=existing.type||"expense";
  return `<form id="transactionForm" class="form-grid">
    <input type="hidden" name="id" value="${existing.id||""}">
    <label>Date<input name="date" type="date" value="${existing.date||todayISO()}" required></label>
    <label>Type<select name="type"><option value="expense" ${type==="expense"?"selected":""}>Expense</option><option value="income" ${type==="income"?"selected":""}>Income</option><option value="refund" ${type==="refund"?"selected":""}>Refund / reimbursement</option><option value="transfer" ${type==="transfer"?"selected":""}>Transfer</option></select></label>
    <label class="span-2">Payee / description<input name="payee" value="${escapeHTML(existing.payee||"")}" placeholder="Walmart, paycheck, rent…" required></label>
    <label>Amount<input name="amount" type="number" min="0" step="0.01" value="${Math.abs(num(existing.amount))||""}" required></label>
    <label>Account<select name="accountId" required>${accountOptions(existing.accountId)}</select></label>
    <label id="toAccountLabel" class="${type==="transfer"?"":"hidden"}">Transfer to<select name="toAccountId">${accountOptions(existing.toAccountId)}</select></label>
    <label>Category<select name="category">${categoryOptions(existing.category|| (type==="income"?"Income":"Other"))}</select></label>
    <label class="span-2">Note<textarea name="note" rows="2">${escapeHTML(existing.note||"")}</textarea></label>
    <div class="span-2 button-row"><button class="primary" type="submit">${existing.id?"Save changes":"Add transaction"}</button>${existing.id?`<button type="button" class="danger" id="deleteTransaction">Delete</button>`:""}</div>
  </form>`;
}
function bindTransactionForm(existing={}){
  const form=$("#transactionForm");
  form.type.addEventListener("change",()=>$("#toAccountLabel").classList.toggle("hidden",form.type.value!=="transfer"));
  form.addEventListener("submit",async e=>{
    e.preventDefault(); const d=Object.fromEntries(new FormData(form));
    const amount=Math.abs(num(d.amount));
    if(d.type==="transfer"){
      if(!d.toAccountId || d.accountId===d.toAccountId){toast("Choose a different destination account.");return;}
      if(existing.id){toast("For clean books, delete and recreate transfers instead of editing them.");return;}
      const group=uid();
      const sourceAccount=state.accounts.find(a=>a.id===d.accountId), destinationAccount=state.accounts.find(a=>a.id===d.toAccountId);
      const sourceProjected=sourceAccount?computedAccountBalance(sourceAccount)-amount:null;
      const destinationProjected=destinationAccount?computedAccountBalance(destinationAccount)+amount:null;
      await store.save("transactions",{date:d.date,type:"transfer",payee:d.payee||"Transfer",amount:-amount,accountId:d.accountId,toAccountId:d.toAccountId,category:"Transfer",note:d.note,transferGroup:group});
      await store.save("transactions",{date:d.date,type:"transfer",payee:d.payee||"Transfer",amount:amount,accountId:d.toAccountId,toAccountId:d.accountId,category:"Transfer",note:d.note,transferGroup:group});
      if(sourceProjected!==null) await setLinkedDebtFromProjected(d.accountId,sourceProjected);
      if(destinationProjected!==null) await setLinkedDebtFromProjected(d.toAccountId,destinationProjected);
    } else {
      const signed=signedTransactionAmount(d.type,amount);
      const oldAmount=existing.id?num(existing.amount):0;
      const newAccount=state.accounts.find(a=>a.id===d.accountId);
      const oldAccount=existing.id?state.accounts.find(a=>a.id===existing.accountId):null;
      const newProjected=newAccount?computedAccountBalance(newAccount)+signed-(existing.accountId===d.accountId?oldAmount:0):null;
      const oldProjected=(oldAccount&&existing.accountId!==d.accountId)?computedAccountBalance(oldAccount)-oldAmount:null;
      await store.save("transactions",{id:d.id||undefined,date:d.date,type:d.type,payee:d.payee,amount:signed,accountId:d.accountId,category:d.category,note:d.note||""});
      if(oldProjected!==null) await setLinkedDebtFromProjected(existing.accountId,oldProjected);
      if(newProjected!==null) await setLinkedDebtFromProjected(d.accountId,newProjected);
    }
    closeModal();toast("Checkbook updated.");
  });
  $("#deleteTransaction")?.addEventListener("click",async()=>{if(confirm("Delete this transaction?")){const a=state.accounts.find(x=>x.id===existing.accountId);const projected=a?computedAccountBalance(a)-num(existing.amount):null;await store.remove("transactions",existing.id);if(projected!==null)await setLinkedDebtFromProjected(existing.accountId,projected);closeModal();}});
}
function openTransaction(existing={}){openModal(existing.id?"Edit transaction":"Add transaction",transactionForm(existing),"CHECKBOOK");bindTransactionForm(existing);}

function billForm(b={}){
  return `<form id="billForm" class="form-grid">
    <input type="hidden" name="id" value="${b.id||""}">
    <label class="span-2">Bill name<input name="name" value="${escapeHTML(b.name||"")}" placeholder="Electric, rent, Netflix…" required></label>
    <label>Amount<input name="amount" type="number" min="0" step="0.01" value="${b.amount??""}" required></label>
    <label>Due day<input name="dueDay" type="number" min="1" max="31" value="${b.dueDay??""}" placeholder="Needs setup"></label>
    <label>Paid from<select name="accountId">${accountOptions(b.accountId)}</select></label>
    <label>Category<select name="category">${categoryOptions(b.category||"Utilities")}</select></label>
    <label><span>Autopay?</span><select name="autopay"><option value="false" ${!b.autopay?"selected":""}>No</option><option value="true" ${b.autopay?"selected":""}>Yes</option></select></label>
    <label><span>Active?</span><select name="active"><option value="true" ${b.active!==false?"selected":""}>Yes</option><option value="false" ${b.active===false?"selected":""}>No</option></select></label>
    <div class="span-2 button-row"><button class="primary">Save bill</button>${b.id?`<button type="button" class="danger" id="deleteBill">Delete</button>`:""}</div>
  </form>`;
}
function openBill(b={}){
  openModal(b.id?"Edit bill":"Add bill",billForm(b),"BILLS");
  $("#billForm").addEventListener("submit",async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));await store.save("bills",{...d,id:d.id||undefined,amount:num(d.amount),dueDay:d.dueDay?num(d.dueDay):null,needsReview:false,amountEstimated:false,autopay:d.autopay==="true",active:d.active==="true"});closeModal();toast("Bill saved.");});
  $("#deleteBill")?.addEventListener("click",async()=>{if(confirm("Delete this bill?")){await store.remove("bills",b.id);closeModal();}});
}
function openPayBill(b){
  const mk=monthKey(), due=dueDateForMonth(b,mk);
  openModal(`Pay ${b.name}`,`<form id="payBillForm" class="stack">
    <p class="muted">${money(b.amount)} • ${due?`due ${fmtDate(due)}`:"due day not set yet"}</p>
    <label>Payment date<input name="date" type="date" value="${todayISO()}" required></label>
    <label>Amount paid<input name="amount" type="number" min="0" step="0.01" value="${b.amount}" required></label>
    <label>Account<select name="accountId">${accountOptions(b.accountId)}</select></label>
    <label><span>Also record this in the checkbook?</span><select name="record"><option value="true">Yes — recommended</option><option value="false">No</option></select></label>
    <button class="primary">Mark paid</button>
  </form>`,"BILL PAYMENT");
  $("#payBillForm").addEventListener("submit",async e=>{
    e.preventDefault();const d=Object.fromEntries(new FormData(e.target));const pid=paymentKey(b.id,mk);
    await store.save("billPayments",{id:pid,billId:b.id,month:mk,date:d.date,amount:num(d.amount),accountId:d.accountId});
    if(d.record==="true"&&d.accountId) await store.save("transactions",{date:d.date,type:"expense",payee:b.name,amount:-Math.abs(num(d.amount)),accountId:d.accountId,category:b.category||"Bill",note:`Bill payment • ${mk}`,billPaymentId:pid});
    closeModal();toast("Bill marked paid.");
  });
}

function debtForm(d={}){
  return `<form id="debtForm" class="form-grid">
    <input type="hidden" name="id" value="${d.id||""}">
    <label class="span-2">Debt name<input name="name" value="${escapeHTML(d.name||"")}" placeholder="Chase Freedom, car loan…" required></label>
    <label>Type<select name="type"><option ${d.type==="Credit Card"?"selected":""}>Credit Card</option><option ${d.type==="Auto Loan"?"selected":""}>Auto Loan</option><option ${d.type==="Student Loan"?"selected":""}>Student Loan</option><option ${d.type==="Personal Loan"?"selected":""}>Personal Loan</option><option ${d.type==="Mortgage"?"selected":""}>Mortgage</option><option ${d.type==="Retirement Plan Loan"?"selected":""}>Retirement Plan Loan</option><option ${d.type==="Other"?"selected":""}>Other</option></select></label>
    <label>Current balance<input name="balance" type="number" min="0" step="0.01" value="${d.balance??""}" required></label>
    <label>APR %<input name="apr" type="number" min="0" step="0.01" value="${d.apr??""}"></label>
    <label>Minimum payment<input name="minimumPayment" type="number" min="0" step="0.01" value="${d.minimumPayment??""}"></label>
    <label>Credit limit (cards only)<input name="limit" type="number" min="0" step="0.01" value="${d.limit??""}"></label>
    <label>Due day<input name="dueDay" type="number" min="1" max="31" value="${d.dueDay??""}" placeholder="Needs setup"></label>
    <div class="span-2 button-row"><button class="primary">Save debt</button>${d.id?`<button type="button" class="danger" id="deleteDebt">Delete</button>`:""}</div>
  </form>`;
}
function openDebt(d={}){
  openModal(d.id?"Edit debt":"Add debt",debtForm(d),"DEBT CENTER");
  $("#debtForm").addEventListener("submit",async e=>{e.preventDefault();const x=Object.fromEntries(new FormData(e.target));await store.save("debts",{...x,id:x.id||undefined,balance:num(x.balance),apr:x.apr===""?null:num(x.apr),minimumPayment:x.minimumPayment===""?null:num(x.minimumPayment),limit:x.limit===""?null:num(x.limit),dueDay:x.dueDay===""?null:num(x.dueDay),needsReview:false});closeModal();toast("Debt saved.");});
  $("#deleteDebt")?.addEventListener("click",async()=>{if(confirm("Delete this debt?")){await store.remove("debts",d.id);closeModal();}});
}
function openDebtPayment(d){
  openModal(`Pay ${d.name}`,`<form id="debtPayForm" class="stack">
    <label>Date<input name="date" type="date" value="${todayISO()}" required></label>
    <label>Payment amount<input name="amount" type="number" min="0" max="${d.balance}" step="0.01" value="${d.minimumPayment||""}" required></label>
    <label>Paid from<select name="accountId">${accountOptions("")}</select></label>
    <label><span>Also record in checkbook?</span><select name="record"><option value="true">Yes — recommended</option><option value="false">No</option></select></label>
    <button class="primary">Record payment</button>
  </form>`,"DEBT PAYMENT");
  $("#debtPayForm").addEventListener("submit",async e=>{e.preventDefault();const x=Object.fromEntries(new FormData(e.target));const amt=Math.abs(num(x.amount));
    await store.save("debts",{...d,balance:Math.max(0,num(d.balance)-amt)});
    if(x.record==="true"&&x.accountId){
      if(d.accountId){
        const group=uid();
        await store.save("transactions",{date:x.date,type:"transfer",payee:`${d.name} payment`,amount:-amt,accountId:x.accountId,toAccountId:d.accountId,category:"Credit Card Payment",note:"Debt payment",debtId:d.id,transferGroup:group});
        await store.save("transactions",{date:x.date,type:"transfer",payee:`${d.name} payment`,amount:amt,accountId:d.accountId,toAccountId:x.accountId,category:"Credit Card Payment",note:"Debt payment",debtId:d.id,transferGroup:group});
      }else{
        await store.save("transactions",{date:x.date,type:"expense",payee:d.name,amount:-amt,accountId:x.accountId,category:"Debt Payment",note:"Debt payment",debtId:d.id});
      }
    }
    closeModal();toast("Debt balance updated.");
  });
}

function accountForm(a={}){
  return `<form id="accountForm" class="form-grid">
    <input type="hidden" name="id" value="${a.id||""}">
    <label class="span-2">Account name<input name="name" value="${escapeHTML(a.name||"")}" placeholder="Main checking" required></label>
    <label>Type<select name="type"><option value="checking" ${a.type==="checking"?"selected":""}>Checking</option><option value="savings" ${a.type==="savings"?"selected":""}>Savings</option><option value="cash" ${a.type==="cash"?"selected":""}>Cash</option><option value="credit" ${a.type==="credit"?"selected":""}>Credit card</option><option value="retirement" ${a.type==="retirement"?"selected":""}>Retirement</option><option value="investment" ${a.type==="investment"?"selected":""}>Investment</option><option value="other" ${a.type==="other"?"selected":""}>Other</option></select></label>
    <label>Starting balance<input name="openingBalance" type="number" step="0.01" value="${a.openingBalance??""}" required></label>
    <label>Include in Safe to Spend?<select name="includeInSafeToSpend"><option value="true" ${a.includeInSafeToSpend===true?"selected":""}>Yes</option><option value="false" ${a.includeInSafeToSpend!==true?"selected":""}>No</option></select></label>
    <label>Owner / label<input name="owner" value="${escapeHTML(a.owner||"")}" placeholder="Optional"></label>
    <div class="span-2"><p class="tiny muted">Checking/cash you actively spend from can be included in Safe to Spend. Savings, retirement, and credit cards usually should not be.</p></div>
    <div class="span-2 button-row"><button class="primary">Save account</button>${a.id?`<button type="button" class="danger" id="deleteAccount">Delete</button>`:""}</div>
  </form>`;
}
function openAccount(a={}){
  openModal(a.id?"Edit account":"Add account",accountForm(a),"ACCOUNTS");
  $("#accountForm").addEventListener("submit",async e=>{e.preventDefault();const x=Object.fromEntries(new FormData(e.target));await store.save("accounts",{...x,id:x.id||undefined,openingBalance:num(x.openingBalance),includeInSafeToSpend:x.includeInSafeToSpend==="true"});closeModal();toast("Account saved.");});
  $("#deleteAccount")?.addEventListener("click",async()=>{if(confirm("Delete this account? Existing transactions will remain but become unassigned.")){await store.remove("accounts",a.id);closeModal();}});
}
function openReconcile(a){
  const calc=computedAccountBalance(a);
  openModal(`Reconcile ${a.name}`,`<form id="reconcileForm" class="stack">
    <p class="muted">Money HQ currently calculates <strong>${money(calc)}</strong>. Enter what the bank actually shows. The difference will become a clearly labeled adjustment transaction.</p>
    <label>Bank's actual balance<input name="actual" type="number" step="0.01" value="${calc.toFixed(2)}" required></label>
    <label>Adjustment date<input name="date" type="date" value="${todayISO()}" required></label>
    <button class="primary">Reconcile account</button>
  </form>`,"RECONCILIATION");
  $("#reconcileForm").addEventListener("submit",async e=>{e.preventDefault();const x=Object.fromEntries(new FormData(e.target));const diff=num(x.actual)-calc;
    if(Math.abs(diff)<.005){toast("It already matches.");closeModal();return;}
    await store.save("transactions",{date:x.date,type:diff>0?"income":"expense",payee:"Reconciliation adjustment",amount:diff,accountId:a.id,category:"Other",note:`Adjusted register to bank balance ${money(x.actual)}`});
    closeModal();toast(`Reconciled by ${money(diff)}.`);
  });
}

function incomeForm(i={}){
  return `<form id="incomeForm" class="form-grid">
    <input type="hidden" name="id" value="${i.id||""}">
    <label class="span-2">Income name<input name="name" value="${escapeHTML(i.name||"")}" placeholder="Paycheck, tips, side job…" required></label>
    <label>Expected amount<input name="amount" type="number" min="0" step="0.01" value="${i.amount??""}" required></label>
    <label>Frequency<select name="frequency"><option value="weekly" ${i.frequency==="weekly"?"selected":""}>Weekly</option><option value="biweekly" ${i.frequency==="biweekly"?"selected":""}>Every 2 weeks</option><option value="semimonthly" ${i.frequency==="semimonthly"?"selected":""}>Twice monthly (approx.)</option><option value="monthly" ${i.frequency==="monthly"?"selected":""}>Monthly</option></select></label>
    <label>Next expected date<input name="nextDate" type="date" value="${i.nextDate||todayISO()}" required></label>
    <label>Deposit to<select name="accountId">${accountOptions(i.accountId)}</select></label>
    <label>Active<select name="active"><option value="true" ${i.active!==false?"selected":""}>Yes</option><option value="false" ${i.active===false?"selected":""}>Paused</option></select></label>
    <div></div>
    <div class="span-2 button-row"><button class="primary">Save income schedule</button>${i.id?`<button type="button" class="danger" id="deleteIncome">Delete</button>`:""}</div>
  </form>`;
}
function openIncome(i={}){
  openModal(i.id?"Edit income":"Add income schedule",incomeForm(i),"INCOME");
  $("#incomeForm").addEventListener("submit",async e=>{e.preventDefault();const x=Object.fromEntries(new FormData(e.target));await store.save("incomeSchedules",{...x,id:x.id||undefined,amount:num(x.amount),active:x.active==="true"});closeModal();toast("Income schedule saved.");});
  $("#deleteIncome")?.addEventListener("click",async()=>{if(confirm("Delete this income schedule?")){await store.remove("incomeSchedules",i.id);closeModal();}});
}
function receiveIncome(i){
  openModal(`Receive ${i.name}`,`<form id="receiveIncomeForm" class="stack">
    <label>Date received<input name="date" type="date" value="${i.nextDate||todayISO()}" required></label>
    <label>Actual amount<input name="amount" type="number" min="0" step="0.01" value="${i.amount}" required></label>
    <label>Deposit account<select name="accountId">${accountOptions(i.accountId)}</select></label>
    <button class="primary">Add to checkbook</button>
  </form>`,"INCOME");
  $("#receiveIncomeForm").addEventListener("submit",async e=>{e.preventDefault();const x=Object.fromEntries(new FormData(e.target));
    await store.save("transactions",{date:x.date,type:"income",payee:i.name,amount:Math.abs(num(x.amount)),accountId:x.accountId,category:"Income",note:"Scheduled income"});
    await store.save("incomeSchedules",{...i,nextDate:advanceDate(i.nextDate||x.date,i.frequency)});
    closeModal();toast("Income recorded and next payday advanced.");
  });
}


async function importMoneyHQFile(file){
  const text=await file.text(); let data;
  try{data=JSON.parse(text);}catch{throw new Error("That file is not valid JSON.");}
  if(!data || !Array.isArray(data.transactions) || !Array.isArray(data.accounts)) throw new Error("This is not a Money HQ import file.");
  const names=["accounts","transactions","bills","billPayments","debts","incomeSchedules","settings","reviewFlags"];
  const count=names.reduce((n,c)=>n+(Array.isArray(data[c])?data[c].length:0),0);
  if((state.transactions.length||state.accounts.length) && !confirm(`Money HQ already contains data. Matching imported records will be replaced by stable ID. Continue with ${count.toLocaleString()} records?`)) return;
  if(mode==="firebase"){
    const writes=[]; for(const c of names) for(const item of (data[c]||[])) writes.push([c,item]);
    for(let i=0;i<writes.length;i+=400){
      const batch=fb.fsMod.writeBatch(fb.db);
      for(const [c,item] of writes.slice(i,i+400)){
        const id=item.id||uid(), ref=fb.fsMod.doc(fb.db,"users",currentUser.uid,c,id);
        batch.set(ref,JSON.parse(JSON.stringify({...item,id,updatedAt:new Date().toISOString()})),{merge:true});
      }
      await batch.commit();
    }
  }else{
    for(const c of names){
      const map=new Map((state[c]||[]).map(x=>[x.id,x]));
      for(const raw of (data[c]||[])){const id=raw.id||uid();map.set(id,{...raw,id,updatedAt:new Date().toISOString()});}
      state[c]=[...map.values()]; localStorage.setItem(`moneyhq:${c}`,JSON.stringify(state[c]));
    }
    renderAll();
  }
  $("#importStatus").textContent=`Imported ${data.accounts.length} accounts, ${data.transactions.length.toLocaleString()} ledger entries, ${data.debts?.length||0} debts, and ${data.bills?.length||0} bill candidates.`;
  toast("2026 ledger import complete.");
}

function downloadFile(name,content,type="text/plain"){
  const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),500);
}
function exportCSV(){
  const headers=["date","payee","category","account","type","amount","note"];
  const quote=v=>`"${String(v??"").replaceAll('"','""')}"`;
  const rows=[headers.join(","),...state.transactions.sort((a,b)=>(a.date||"").localeCompare(b.date||"")).map(t=>[
    t.date,t.payee,t.category,accountName(t.accountId),t.type,num(t.amount).toFixed(2),t.note
  ].map(quote).join(","))];
  downloadFile(`money-hq-transactions-${todayISO()}.csv`,rows.join("\n"),"text/csv");
}
function fullBackup(){downloadFile(`money-hq-backup-${todayISO()}.json`,JSON.stringify({exportedAt:new Date().toISOString(),...state},null,2),"application/json");}

function wireEvents(){
  setText("#todayLabel",new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"}));
  $("#ledgerMonth").value=monthKey();$("#reportMonth").value=monthKey();
  $("#nav").addEventListener("click",e=>{const b=e.target.closest("[data-view]");if(b)showView(b.dataset.view);});
  document.addEventListener("click",e=>{
    const go=e.target.closest("[data-go]");if(go)showView(go.dataset.go);
    if(e.target.closest("#quickAddBtn,#addTransactionBtn"))openTransaction();
    if(e.target.closest("#addBillBtn"))openBill();
    if(e.target.closest("#addDebtBtn"))openDebt();
    if(e.target.closest("#addAccountBtn"))openAccount();
    if(e.target.closest("#addIncomeBtn"))openIncome();

    const tx=e.target.closest("[data-edit-tx]");if(tx)openTransaction(state.transactions.find(x=>x.id===tx.dataset.editTx));
    const eb=e.target.closest("[data-edit-bill]");if(eb)openBill(state.bills.find(x=>x.id===eb.dataset.editBill));
    const pb=e.target.closest("[data-pay-bill]");if(pb)openPayBill(state.bills.find(x=>x.id===pb.dataset.payBill));
    const up=e.target.closest("[data-unpay-bill]");if(up){const b=state.bills.find(x=>x.id===up.dataset.unpayBill),mk=monthKey(),pid=paymentKey(b.id,mk); if(confirm("Mark this bill unpaid again? This does not delete any checkbook transaction already recorded."))store.remove("billPayments",pid);}
    const ed=e.target.closest("[data-edit-debt]");if(ed)openDebt(state.debts.find(x=>x.id===ed.dataset.editDebt));
    const pd=e.target.closest("[data-pay-debt]");if(pd)openDebtPayment(state.debts.find(x=>x.id===pd.dataset.payDebt));
    const ea=e.target.closest("[data-edit-account]");if(ea)openAccount(state.accounts.find(x=>x.id===ea.dataset.editAccount));
    const rc=e.target.closest("[data-reconcile]");if(rc)openReconcile(state.accounts.find(x=>x.id===rc.dataset.reconcile));
    const ei=e.target.closest("[data-edit-income]");if(ei)openIncome(state.incomeSchedules.find(x=>x.id===ei.dataset.editIncome));
    const ri=e.target.closest("[data-receive-income]");if(ri)receiveIncome(state.incomeSchedules.find(x=>x.id===ri.dataset.receiveIncome));
  });
  $("#closeModal").addEventListener("click",closeModal);
  $("#modal").addEventListener("click",e=>{if(e.target===$("#modal"))closeModal();});
  ["ledgerSearch","ledgerAccountFilter","ledgerMonth"].forEach(id=>$("#"+id).addEventListener("input",renderLedger));
  $("#reportMonth").addEventListener("input",renderReports);
  $("#exportCsvBtn").addEventListener("click",exportCSV);$("#backupBtn").addEventListener("click",fullBackup);
  $("#importLedgerBtn")?.addEventListener("click",async()=>{const file=$("#importLedgerFile")?.files?.[0];if(!file){toast("Choose the private Money HQ import JSON first.");return;}try{await importMoneyHQFile(file);}catch(err){toast(err.message);}});
  $("#settingsForm").addEventListener("submit",async e=>{e.preventDefault();await store.save("settings",{id:"main",reserveAmount:num($("#reserveAmount").value)});toast("Protected cash updated.");});
}

async function init(){
  wireEvents();
  if(firebaseReady){
    mode="firebase";
    await initFirebase();
    $("#authForm").addEventListener("submit",async e=>{e.preventDefault();try{await fb.authMod.signInWithEmailAndPassword(fb.auth,$("#authEmail").value,$("#authPassword").value);}catch(err){toast(err.message);}});
    $("#createAccountBtn").addEventListener("click",async()=>{try{await fb.authMod.createUserWithEmailAndPassword(fb.auth,$("#authEmail").value,$("#authPassword").value);}catch(err){toast(err.message);}});
    $("#signOutBtn").addEventListener("click",()=>fb.authMod.signOut(fb.auth));
  }else{
    mode="local";$("#modeBadge").textContent="Local test mode • not synced";
    $("#signOutBtn").classList.add("hidden");$("#authScreen").classList.add("hidden");$("#appShell").classList.remove("hidden");
    await store.start();
  }
}
init();
