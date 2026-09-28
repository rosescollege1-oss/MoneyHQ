import { firebaseConfig } from "./firebase-config.js";

const FIREBASE_VERSION = "12.19.0";
const COLLECTIONS = ["accounts","transactions","bills","billPayments","debts","incomeSchedules","settings","reviewFlags","goals","moneyTasks","categoryTargets"];
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
let calendarCursor = new Date();
let state = {
  accounts:[], transactions:[], bills:[], billPayments:[], debts:[], incomeSchedules:[], reviewFlags:[],
  goals:[], moneyTasks:[], categoryTargets:[], settings:[{id:"main",reserveAmount:0}]
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

function asDate(iso){return new Date(`${iso}T12:00:00`);}
function isoDate(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;}
function addDaysISO(iso,days){const d=asDate(iso);d.setDate(d.getDate()+days);return isoDate(d);}
function previousMonthKey(mk){const [y,m]=mk.split("-").map(Number),d=new Date(y,m-2,1);return monthKey(d);}
function monthRange(mk){const [y,m]=mk.split("-").map(Number);return {start:`${mk}-01`,end:isoDate(new Date(y,m,0))};}
function incomeOccurrencesBetween(startISO,endISO){
  const out=[];
  for(const schedule of state.incomeSchedules.filter(i=>i.active!==false&&i.nextDate)){
    let cur=schedule.nextDate, guard=0;
    while(cur<startISO && guard++<1000) cur=advanceDate(cur,schedule.frequency);
    while(cur<=endISO && guard++<1200){out.push({...schedule,_date:cur});cur=advanceDate(cur,schedule.frequency);}
  }
  return out.sort((a,b)=>a._date.localeCompare(b._date));
}
function nextIncomeOccurrence(){
  const occ=incomeOccurrencesBetween(todayISO(),addDaysISO(todayISO(),366));
  if(!occ.length) return null;
  const date=occ[0]._date, same=occ.filter(x=>x._date===date);
  return {date,amount:same.reduce((s,x)=>s+num(x.amount),0),items:same};
}
function billOccurrencesBetween(startISO,endISO){
  const out=[], start=asDate(startISO), end=asDate(endISO);
  for(const bill of state.bills.filter(b=>b.active!==false)){
    let cursor=new Date(start.getFullYear(),start.getMonth(),1),guard=0;
    while(cursor<=end && guard++<36){
      const mk=monthKey(cursor), due=dueDateForMonth(bill,mk);
      if(due && due>=startISO && due<=endISO) out.push({...bill,_month:mk,_due:due,_paid:isBillPaid(bill,mk)});
      cursor.setMonth(cursor.getMonth()+1);
    }
  }
  return out.sort((a,b)=>a._due.localeCompare(b._due));
}
function monthStats(mk){
  const tx=monthTransactions(mk);
  const income=tx.filter(t=>t.type==="income").reduce((s,t)=>s+Math.max(0,num(t.amount)),0);
  const gross=Math.abs(tx.filter(t=>t.type==="expense"&&num(t.amount)<0).reduce((s,t)=>s+num(t.amount),0));
  const refunds=tx.filter(t=>t.type==="refund"&&num(t.amount)>0).reduce((s,t)=>s+num(t.amount),0);
  const expenses=Math.max(0,gross-refunds);
  return {tx,income,expenses,net:income-expenses,refunds};
}
function trackedAssets(){return state.accounts.filter(a=>a.type!=="credit").reduce((s,a)=>s+computedAccountBalance(a),0);}
function savingsAssets(){return state.accounts.filter(a=>["savings","retirement","investment"].includes(a.type)).reduce((s,a)=>s+computedAccountBalance(a),0);}
function totalDebt(){return state.debts.reduce((s,d)=>s+num(d.balance),0);}
function trackedNetWorth(){return trackedAssets()-totalDebt();}
function targetForCategory(category){return state.categoryTargets.find(t=>t.category===category);}
function goalPercent(g){return num(g.targetAmount)>0?Math.max(0,Math.min(100,num(g.currentAmount)/num(g.targetAmount)*100)):0;}
function daysBetween(a,b){return Math.max(0,Math.ceil((asDate(b)-asDate(a))/86400000));}
function simulatePayoff(strategy,extra){
  const source=state.debts.filter(d=>num(d.balance)>0).map(d=>({id:d.id,name:d.name,balance:num(d.balance),apr:num(d.apr),min:Math.max(0,num(d.minimumPayment))}));
  if(!source.length) return {months:0,interest:0};
  const budget=source.reduce((s,d)=>s+d.min,0)+Math.max(0,num(extra));
  if(budget<=0) return {months:null,interest:null};
  let debts=source.map(d=>({...d})),months=0,interest=0;
  while(debts.some(d=>d.balance>.005) && months<600){
    months++;
    for(const d of debts){if(d.balance<=0)continue;const i=d.balance*(d.apr/100)/12;d.balance+=i;interest+=i;}
    let remaining=budget;
    for(const d of debts){if(d.balance<=0)continue;const pay=Math.min(d.balance,d.min,remaining);d.balance-=pay;remaining-=pay;}
    while(remaining>.005){
      const open=debts.filter(d=>d.balance>.005).sort((a,b)=>strategy==="snowball"?(a.balance-b.balance):(b.apr-a.apr||a.balance-b.balance));
      if(!open.length)break;const target=open[0],pay=Math.min(target.balance,remaining);target.balance-=pay;remaining-=pay;
      if(pay<=.005)break;
    }
  }
  return {months:months>=600?null:months,interest:months>=600?null:interest};
}
function payoffText(result){if(result.months===0)return "Already paid off 🎉";if(result.months===null)return "Not paid off within 50 years with these inputs";const y=Math.floor(result.months/12),m=result.months%12;return `${y?`${y}y `:""}${m?`${m}mo`:""}`.trim();}

function monthTransactions(mk=monthKey()){
  return state.transactions.filter(t=>(t.date||"").slice(0,7)===mk && t.type!=="transfer");
}
function setText(id,v){const el=$(id); if(el) el.textContent=v;}
function empty(msg){return `<div class="empty">${escapeHTML(msg)}</div>`;}

function renderDashboard(){
  const cash=cashTotal(), nextIncome=nextIncomeOccurrence();
  const before=nextIncome?billOccurrencesBetween(todayISO(),nextIncome.date).filter(b=>!b._paid).reduce((s,b)=>s+num(b.amount),0):0;
  const reserve=num(getSettings().reserveAmount), safe=cash-before-reserve, debt=totalDebt();
  const knownMins=state.debts.filter(d=>d.minimumPayment!==null&&d.minimumPayment!==undefined&&d.minimumPayment!=="");
  setText("#safeToSpend",money(safe));setText("#cashAvailable",money(cash));setText("#billsBeforePayday",money(before));setText("#totalDebt",money(debt));
  setText("#nextPaydayText",nextIncome?`through ${fmtDate(nextIncome.date)}`:"Add recurring income");
  setText("#safeToSpendDetail",`${money(before)} upcoming + ${money(reserve)} protected`);
  setText("#debtDetail",knownMins.length===state.debts.length?`${money(knownMins.reduce((s,d)=>s+num(d.minimumPayment),0))} minimums / month`:`${knownMins.length} of ${state.debts.length} minimums entered`);
  setText("#affordCash",money(cash));setText("#affordBills",money(before));setText("#affordReserve",money(reserve));setText("#affordAvailable",money(safe));
  if(nextIncome){const days=Math.max(1,daysBetween(todayISO(),nextIncome.date));setText("#daysToIncome",`${days} day${days===1?"":"s"} until ${fmtDate(nextIncome.date)}`);setText("#dailyFlexible",safe>0?`${money(safe/days)}/day`:money(0));}else{setText("#daysToIncome","Add a recurring income schedule");setText("#dailyFlexible","—");}

  const stats=monthStats(monthKey()),prev=monthStats(previousMonthKey(monthKey()));
  setText("#monthIncome",money(stats.income));setText("#monthSpent",money(stats.expenses));setText("#monthNet",money(stats.net));
  const spendDiff=stats.expenses-prev.expenses;
  setText("#monthComparison",prev.expenses?`${spendDiff>=0?"Spending is":"Spending is"} ${money(Math.abs(spendDiff))} ${spendDiff>=0?"higher":"lower"} than last month so far.`:"Last month comparison will appear once there is history.");

  const currentMK=monthKey(),active=state.bills.filter(b=>b.active!==false),paid=active.filter(b=>isBillPaid(b,currentMK)),still=active.filter(b=>!isBillPaid(b,currentMK));
  const pct=active.length?Math.round(paid.length/active.length*100):0;
  const ring=$("#billProgressRing");if(ring)ring.style.setProperty("--pct",pct);setText("#billProgressPct",`${pct}%`);setText("#billProgressLabel",`${paid.length} of ${active.length} handled`);setText("#billProgressAmount",`${money(still.reduce((s,b)=>s+num(b.amount),0))} still due`);

  const horizon=addDaysISO(todayISO(),30), bills=billOccurrencesBetween(todayISO(),horizon).filter(b=>!b._paid).map(b=>({date:b._due,name:b.name,amount:-num(b.amount),kind:"bill",id:b.id,month:b._month}));
  const incomes=incomeOccurrencesBetween(todayISO(),horizon).map(i=>({date:i._date,name:i.name,amount:num(i.amount),kind:"income",id:i.id}));
  const upcoming=[...bills,...incomes].sort((a,b)=>a.date.localeCompare(b.date)).slice(0,7);
  $("#upcomingMoney").innerHTML=upcoming.length?upcoming.map(x=>`<div class="list-row"><div class="list-main"><strong>${x.kind==="income"?"↗ ":"↘ "}${escapeHTML(x.name)}</strong><span>${fmtDate(x.date)}</span></div><span class="amount ${x.amount<0?"negative":"positive"}">${money(x.amount)}</span></div>`).join(""):empty("Nothing scheduled in the next 30 days.");

  const debts=[...state.debts].sort((a,b)=>num(b.balance)-num(a.balance)).slice(0,5);
  $("#debtSnapshot").innerHTML=debts.length?debts.map(d=>`<div class="list-row"><div class="list-main"><strong>${escapeHTML(d.name)}</strong><span>${d.apr===null||d.apr===undefined?"APR needed":`${num(d.apr).toFixed(2)}% APR`} • ${d.minimumPayment===null||d.minimumPayment===undefined?"minimum needed":`min ${money(d.minimumPayment)}`}</span></div><span class="amount">${money(d.balance)}</span></div>`).join(""):empty("No debt records yet.");

  const goals=[...state.goals].sort((a,b)=>goalPercent(b)-goalPercent(a)).slice(0,4);
  $("#dashboardGoals").innerHTML=goals.length?goals.map(g=>`<div class="list-row"><div class="list-main"><strong>${escapeHTML(g.emoji||"🎯")} ${escapeHTML(g.name)}</strong><span>${goalPercent(g).toFixed(0)}% • ${money(g.currentAmount)} of ${money(g.targetAmount)}</span></div><span class="amount">${money(Math.max(0,num(g.targetAmount)-num(g.currentAmount)))}</span></div>`).join(""):empty("Add a sinking fund or goal when you're ready.");
  const tasks=state.moneyTasks.filter(t=>!t.completed).sort((a,b)=>(a.dueDate||"9999").localeCompare(b.dueDate||"9999")).slice(0,5);
  $("#dashboardTasks").innerHTML=tasks.length?tasks.map(t=>`<div class="list-row"><div class="list-main"><strong>${escapeHTML(t.title)}</strong><span>${t.dueDate?`Due ${fmtDate(t.dueDate)}`:"No due date"}</span></div><button class="text-btn" data-toggle-task="${t.id}">Done</button></div>`).join(""):empty("No money chores waiting. Beautiful.");

  const recent=[...state.transactions].sort((a,b)=>(b.date||"").localeCompare(a.date||"")).slice(0,8);
  $("#recentTransactions").innerHTML=recent.length?recent.map(t=>`<div class="list-row"><div class="list-main"><button class="merchant-link" data-merchant="${escapeHTML(t.payee||"Transaction")}">${escapeHTML(t.payee||"Transaction")}</button><span>${fmtTransactionDate(t)} • ${escapeHTML(t.category||"Uncategorized")}</span></div><span class="amount ${num(t.amount)<0?"negative":"positive"}">${money(t.amount)}</span></div>`).join(""):empty("No transactions yet.");
  $("#setupNotice").classList.toggle("hidden",state.accounts.length>0||state.bills.length>0||state.debts.length>0);
}
function renderLedger(){
  const af=$("#ledgerAccountFilter"),cf=$("#ledgerCategoryFilter"),currentA=af.value,currentC=cf.value;
  af.innerHTML=`<option value="">All accounts</option>`+state.accounts.map(a=>`<option value="${a.id}">${escapeHTML(a.name)}</option>`).join("");af.value=currentA;
  const cats=[...new Set(state.transactions.map(t=>t.category).filter(Boolean))].sort();cf.innerHTML=`<option value="">All categories</option>`+cats.map(c=>`<option>${escapeHTML(c)}</option>`).join("");cf.value=currentC;
  const q=$("#ledgerSearch").value.toLowerCase().trim(),acc=af.value,cat=cf.value,type=$("#ledgerTypeFilter").value,mk=$("#ledgerMonth").value;
  const rows=[...state.transactions].filter(t=>{const hay=`${t.payee||""} ${t.note||""} ${t.category||""} ${accountName(t.accountId)}`.toLowerCase();return(!q||hay.includes(q))&&(!acc||t.accountId===acc)&&(!cat||t.category===cat)&&(!type||t.type===type)&&(!mk||(t.date||"").startsWith(mk));}).sort((a,b)=>(b.date||"").localeCompare(a.date||"")||(b.updatedAt||"").localeCompare(a.updatedAt||""));
  $("#transactionTable").innerHTML=rows.length?rows.map(t=>`<tr><td>${fmtTransactionDate(t)}</td><td><button class="merchant-link" data-merchant="${escapeHTML(t.payee||"")}">${escapeHTML(t.payee||"")}</button>${t.note?`<div class="tiny muted">${escapeHTML(t.note)}</div>`:""}</td><td>${escapeHTML(t.category||"")}</td><td>${escapeHTML(accountName(t.accountId))}</td><td class="right amount ${num(t.amount)<0?"negative":"positive"}">${money(t.amount)}</td><td class="right"><button class="text-btn" data-edit-tx="${t.id}">Edit</button></td></tr>`).join(""):`<tr><td colspan="6">${empty("No matching transactions.")}</td></tr>`;
}
function renderCalendar(){
  const y=calendarCursor.getFullYear(),m=calendarCursor.getMonth(),mk=monthKey(calendarCursor);setText("#calendarMonthLabel",calendarCursor.toLocaleDateString("en-US",{month:"long",year:"numeric"}));
  const first=new Date(y,m,1),last=new Date(y,m+1,0),gridStart=new Date(y,m,1-first.getDay()),gridEnd=new Date(y,m+1,6-last.getDay());
  const bills=billOccurrencesBetween(isoDate(gridStart),isoDate(gridEnd)),incomes=incomeOccurrencesBetween(isoDate(gridStart),isoDate(gridEnd));
  let html="";for(let d=new Date(gridStart);d<=gridEnd;d.setDate(d.getDate()+1)){const iso=isoDate(d),outside=d.getMonth()!==m,today=iso===todayISO();const dayBills=bills.filter(b=>b._due===iso),dayIncome=incomes.filter(i=>i._date===iso);html+=`<div class="calendar-day ${outside?"outside":""} ${today?"today":""}"><div class="calendar-number">${d.getDate()}</div>${dayIncome.map(i=>`<button class="cal-event income" data-receive-income="${i.id}" data-income-date="${i._date}">+ ${escapeHTML(i.name)} ${money(i.amount)}</button>`).join("")}${dayBills.map(b=>`<button class="cal-event bill ${b._paid?"paid":""}" ${b._paid?`data-unpay-bill="${b.id}"`:`data-pay-bill="${b.id}"`} data-bill-month="${b._month}">${b._paid?"✓ ":""}${escapeHTML(b.name)} ${money(b.amount)}</button>`).join("")}</div>`;}
  $("#calendarGrid").innerHTML=html;
  for(const days of [7,14,30]){const end=addDaysISO(todayISO(),days),due=billOccurrencesBetween(todayISO(),end).filter(b=>!b._paid);setText(`#due${days}`,money(due.reduce((s,b)=>s+num(b.amount),0)));setText(`#due${days}Count`,`${due.length} bill${due.length===1?"":"s"}`);}
  const inc30=incomeOccurrencesBetween(todayISO(),addDaysISO(todayISO(),30));setText("#income30",money(inc30.reduce((s,i)=>s+num(i.amount),0)));setText("#income30Count",`${inc30.length} deposit${inc30.length===1?"":"s"}`);
  const next=nextIncomeOccurrence();if(!next){$("#paycheckPlanner").innerHTML=empty("Add an income schedule to turn this on.");return;}const due=billOccurrencesBetween(todayISO(),next.date).filter(b=>!b._paid),dueTotal=due.reduce((s,b)=>s+num(b.amount),0),cash=cashTotal(),reserve=num(getSettings().reserveAmount),after=cash-dueTotal-reserve;
  $("#paycheckPlanner").innerHTML=`<p class="muted tiny">Next scheduled income</p><div class="planner-number">${money(next.amount)}</div><p><strong>${fmtDate(next.date)}</strong> • ${next.items.map(i=>escapeHTML(i.name)).join(" + ")}</p><div class="planner-line"><span>Cash now</span><strong>${money(cash)}</strong></div><div class="planner-line"><span>${due.length} bill${due.length===1?"":"s"} before then</span><strong>− ${money(dueTotal)}</strong></div><div class="planner-line"><span>Protected cash</span><strong>− ${money(reserve)}</strong></div><div class="planner-line"><span>Safe until income</span><strong class="${after<0?"negative":"positive"}">${money(after)}</strong></div>${due.slice(0,7).map(b=>`<div class="planner-line"><span>${escapeHTML(b.name)} • ${fmtDate(b._due)}</span><strong>${money(b.amount)}</strong></div>`).join("")}`;
}
function renderBills(){
  const mk=monthKey(),active=state.bills.filter(b=>b.active!==false),monthly=active.reduce((s,b)=>s+num(b.amount),0),unpaid=active.filter(b=>!isBillPaid(b,mk)),overdue=unpaid.filter(b=>{const due=dueDateForMonth(b,mk);return due&&due<todayISO();}),paid=active.filter(b=>isBillPaid(b,mk));
  setText("#monthlyBills",money(monthly));setText("#billsStillDue",money(unpaid.reduce((s,b)=>s+num(b.amount),0)));setText("#overdueBills",money(overdue.reduce((s,b)=>s+num(b.amount),0)));setText("#paidBills",money(paid.reduce((s,b)=>s+num(b.amount),0)));
  const subs=active.filter(b=>(b.category||"").toLowerCase().includes("subscription")||["Blink","Icloud","ChatGPT","Canva","Google Play"].includes(b.name));setText("#subscriptionTotal",`${money(subs.reduce((s,b)=>s+num(b.amount),0))}/mo`);$("#subscriptionList").innerHTML=subs.length?subs.map(b=>`<span class="chip">${escapeHTML(b.name)} • ${money(b.amount)}</span>`).join(""):empty("No subscriptions categorized yet.");
  const sorted=[...active].sort((a,b)=>(num(a.dueDay)||99)-(num(b.dueDay)||99));$("#billList").innerHTML=sorted.length?sorted.map(b=>{const paidNow=isBillPaid(b,mk),due=dueDateForMonth(b,mk),late=!paidNow&&due&&due<todayISO(),missing=!due,badge=paidNow?"PAID":missing?"SET DUE DAY":late?"OVERDUE":"UPCOMING";return `<article class="card"><div class="card-top"><div><h3>${escapeHTML(b.name)}</h3><div class="sub">${missing?"Due day needs review":`Due day ${b.dueDay}`}${b.autopay?" • Autopay":""}</div></div><span class="pill ${late||missing?"bad":paidNow?"good":"warn"}">${badge}</span></div><div class="big-number">${money(b.amount)}</div><div class="sub">${escapeHTML(b.category||"Bill")} • ${escapeHTML(accountName(b.accountId))}</div><div class="card-actions">${paidNow?`<button class="secondary" data-unpay-bill="${b.id}">Undo paid</button>`:`<button class="primary" data-pay-bill="${b.id}">Mark paid</button>`}<button class="secondary" data-edit-bill="${b.id}">${missing?"Finish setup":"Edit"}</button></div></article>`;}).join(""):empty("No bills yet.");
}
function renderDebts(){
  const total=totalDebt(),knownMins=state.debts.filter(d=>d.minimumPayment!==null&&d.minimumPayment!==undefined&&d.minimumPayment!==""),mins=knownMins.reduce((s,d)=>s+num(d.minimumPayment),0),knownApr=state.debts.filter(d=>d.apr!==null&&d.apr!==undefined&&d.apr!==""),interest=knownApr.reduce((s,d)=>s+num(d.balance)*(num(d.apr)/100)/12,0),highest=knownApr.length?Math.max(...knownApr.map(d=>num(d.apr))):null;
  setText("#debtTotal2",money(total));setText("#minimumTotal",`${money(mins)}${knownMins.length<state.debts.length?"+":""}`);setText("#interestTotal",knownApr.length?`${money(interest)}${knownApr.length<state.debts.length?"+":""}`:"Needs APRs");setText("#highestApr",highest===null?"Needs APRs":`${highest.toFixed(2)}%`);
  const sorted=[...state.debts].sort((a,b)=>num(b.balance)-num(a.balance));$("#debtList").innerHTML=sorted.length?sorted.map(d=>{const util=d.limit?Math.min(100,num(d.balance)/num(d.limit)*100):null,aprKnown=d.apr!==null&&d.apr!==undefined&&d.apr!=="",minKnown=d.minimumPayment!==null&&d.minimumPayment!==undefined&&d.minimumPayment!=="",start=Math.max(num(d.startingBalance),num(d.balance)),progress=start>0?Math.max(0,Math.min(100,(start-num(d.balance))/start*100)):0;return `<article class="card"><div class="card-top"><div><h3>${escapeHTML(d.name)}</h3><div class="sub">${escapeHTML(d.type||"Debt")}${d.owner?` • ${escapeHTML(d.owner)}`:""} • ${d.dueDay?`due day ${d.dueDay}`:"due day needed"}</div></div><span class="pill ${aprKnown?"":"bad"}">${aprKnown?`${num(d.apr).toFixed(2)}% APR`:"APR NEEDED"}</span></div><div class="big-number">${money(d.balance)}</div><div class="goal-progress-label"><span>Payoff progress</span><span>${progress.toFixed(0)}%</span></div><div class="progress"><i style="width:${progress}%"></i></div>${util!==null?`<div class="sub" style="margin-top:8px">${util.toFixed(1)}% utilization of ${money(d.limit)}</div>`:""}<div class="mini-grid"><div><span>Minimum</span><strong>${minKnown?money(d.minimumPayment):"NEEDED"}</strong></div><div><span>Est. interest/mo</span><strong>${aprKnown?money(num(d.balance)*(num(d.apr)/100)/12):"—"}</strong></div></div><div class="card-actions"><button class="primary" data-pay-debt="${d.id}">Record payment</button><button class="secondary" data-edit-debt="${d.id}">Edit</button></div></article>`;}).join(""):empty("Add each debt separately. No judgment, just clean numbers.");
  renderSimulator();
}
function renderSimulator(){const el=$("#simulatorResults");if(!el)return;const extra=num($("#simExtra")?.value);const snow=simulatePayoff("snowball",extra),ava=simulatePayoff("avalanche",extra);el.innerHTML=`<div class="scenario"><span>Lowest balance first</span><strong>${payoffText(snow)}</strong><small>${snow.interest===null?"Needs stronger payment inputs":`${money(snow.interest)} estimated interest`}</small></div><div class="scenario"><span>Highest APR first</span><strong>${payoffText(ava)}</strong><small>${ava.interest===null?"Needs stronger payment inputs":`${money(ava.interest)} estimated interest`}</small></div>`;}
function renderAccounts(){
  const assets=trackedAssets(),savings=savingsAssets();setText("#trackedAssets",money(assets));setText("#accountCashTotal",money(cashTotal()));setText("#savingsInvestments",money(savings));setText("#netWorthTotal",money(trackedNetWorth()));
  const sorted=[...state.accounts].sort((a,b)=>a.name.localeCompare(b.name));$("#accountList").innerHTML=sorted.length?sorted.map(a=>{const bal=computedAccountBalance(a),isCredit=a.type==="credit",badge=a.includeInSafeToSpend===true?"SAFE TO SPEND":isCredit?"CREDIT":"TRACKED";return `<article class="card"><div class="card-top"><div><h3>${escapeHTML(a.name)}</h3><div class="sub">${escapeHTML(a.type)}${a.owner?` • ${escapeHTML(a.owner)}`:""}</div></div><span class="pill">${badge}</span></div><div class="big-number">${isCredit?`${money(Math.abs(bal))} owed`:money(bal)}</div><div class="sub">${state.transactions.filter(t=>t.accountId===a.id).length} checkbook entries</div><div class="card-actions">${isCredit?"":`<button class="secondary" data-reconcile="${a.id}">Reconcile</button>`}<button class="secondary" data-edit-account="${a.id}">Edit</button></div></article>`;}).join(""):empty("Start by adding your real accounts.");
  renderIncome();
}
function renderIncome(){const sorted=[...state.incomeSchedules].sort((a,b)=>(a.nextDate||"").localeCompare(b.nextDate||""));$("#incomeList").innerHTML=sorted.length?sorted.map(i=>`<article class="card"><div class="card-top"><div><h3>${escapeHTML(i.name)}</h3><div class="sub">${escapeHTML(i.frequency)} • next ${fmtDate(i.nextDate)}</div></div><span class="pill ${i.active===false?"bad":"good"}">${i.active===false?"PAUSED":"EXPECTED"}</span></div><div class="big-number">${money(i.amount)}</div><div class="sub">Deposit to ${escapeHTML(accountName(i.accountId))}</div><div class="card-actions"><button class="primary" data-receive-income="${i.id}">Mark received</button><button class="secondary" data-edit-income="${i.id}">Edit</button></div></article>`).join(""):empty("Add expected paychecks or regular income.");}
function renderReports(){
  const mk=$("#reportMonth").value||monthKey(),stats=monthStats(mk),prev=monthStats(previousMonthKey(mk));setText("#reportIncome",money(stats.income));setText("#reportExpenses",money(stats.expenses));setText("#reportNet",money(stats.net));setText("#reportCount",String(stats.tx.length));
  const cats={};stats.tx.filter(t=>t.type==="expense"&&num(t.amount)<0).forEach(t=>cats[t.category||"Uncategorized"]=(cats[t.category||"Uncategorized"]||0)+Math.abs(num(t.amount)));stats.tx.filter(t=>t.type==="refund"&&num(t.amount)>0).forEach(t=>cats[t.category||"Refund"]=(cats[t.category||"Refund"]||0)-num(t.amount));
  const categories=[...new Set([...Object.keys(cats),...state.categoryTargets.map(t=>t.category)])].sort((a,b)=>(cats[b]||0)-(cats[a]||0));$("#categoryReport").innerHTML=categories.length?categories.map(c=>{const spent=Math.max(0,cats[c]||0),target=targetForCategory(c),limit=num(target?.amount),pct=limit?Math.min(100,spent/limit*100):0,over=limit&&spent>limit;return `<div class="guardrail-row"><strong>${escapeHTML(c)}</strong><div class="guardrail-track"><div class="guardrail-fill ${over?"over":""}" style="width:${limit?pct:Math.min(100,spent/(Math.max(...Object.values(cats),1))*100)}%"></div></div><small>${money(spent)}${limit?` / ${money(limit)}`:" • no target"}</small><button class="text-btn" data-target-category="${escapeHTML(c)}">✎</button></div>`;}).join(""):empty("No spending to summarize.");
  const merchants={};stats.tx.filter(t=>t.type==="expense"&&num(t.amount)<0).forEach(t=>merchants[t.payee||"Unknown"]=(merchants[t.payee||"Unknown"]||0)+Math.abs(num(t.amount)));const mr=Object.entries(merchants).sort((a,b)=>b[1]-a[1]).slice(0,12);$("#merchantReport").innerHTML=mr.length?mr.map(([n,v])=>`<div class="list-row"><div class="list-main"><button class="merchant-link" data-merchant="${escapeHTML(n)}">${escapeHTML(n)}</button></div><span class="amount">${money(v)}</span></div>`).join(""):empty("No spending to summarize.");
  const diff=stats.expenses-prev.expenses,top=Object.entries(cats).sort((a,b)=>b[1]-a[1])[0];$("#monthlyRecap").innerHTML=`<div class="planner-line"><span>Money in</span><strong>${money(stats.income)}</strong></div><div class="planner-line"><span>Money out</span><strong>${money(stats.expenses)}</strong></div><div class="planner-line"><span>Net cash flow</span><strong class="${stats.net<0?"negative":"positive"}">${money(stats.net)}</strong></div><div class="planner-line"><span>Compared with previous month</span><strong>${prev.expenses?`${money(Math.abs(diff))} ${diff>=0?"more":"less"} spent`:"—"}</strong></div><div class="planner-line"><span>Largest category</span><strong>${top?`${escapeHTML(top[0])} • ${money(top[1])}`:"—"}</strong></div>`;
}
function renderGoals(){
  const goals=[...state.goals].sort((a,b)=>(a.dueDate||"9999").localeCompare(b.dueDate||"9999"));$("#goalList").innerHTML=goals.length?goals.map(g=>{const pct=goalPercent(g),remaining=Math.max(0,num(g.targetAmount)-num(g.currentAmount));return `<article class="card goal-card"><div class="card-top"><div><div class="goal-emoji">${escapeHTML(g.emoji||"🎯")}</div><h3>${escapeHTML(g.name)}</h3><div class="sub">${g.dueDate?`Target ${fmtDate(g.dueDate)}`:"No deadline"}</div></div><span class="pill good">${pct.toFixed(0)}%</span></div><div class="big-number">${money(g.currentAmount)} <span class="tiny muted">of ${money(g.targetAmount)}</span></div><div class="progress"><i style="width:${pct}%"></i></div><div class="goal-progress-label"><span>${money(remaining)} to go</span><span>${pct.toFixed(0)}%</span></div><div class="card-actions"><button class="primary" data-add-goal-money="${g.id}">Add progress</button><button class="secondary" data-edit-goal="${g.id}">Edit</button></div></article>`;}).join(""):empty("Add a goal like emergency fund, travel, Christmas, or car repairs.");
  const tasks=[...state.moneyTasks].sort((a,b)=>(Number(a.completed)-Number(b.completed))||(a.dueDate||"9999").localeCompare(b.dueDate||"9999"));$("#moneyTaskList").innerHTML=tasks.length?tasks.map(t=>`<div class="task-item ${t.completed?"done":""}"><button class="task-check" data-toggle-task="${t.id}">${t.completed?"✓":""}</button><div class="task-body"><strong>${escapeHTML(t.title)}</strong><span>${t.dueDate?`Due ${fmtDate(t.dueDate)} • `:""}${escapeHTML(t.note||"")}</span></div><button class="text-btn" data-edit-task="${t.id}">Edit</button></div>`).join(""):empty("No money tasks yet.");
  const target=goals.reduce((s,g)=>s+num(g.targetAmount),0),current=goals.reduce((s,g)=>s+num(g.currentAmount),0),pct=target?current/target*100:0;$("#goalSummary").innerHTML=`<div class="goal-summary-big">${money(current)}</div><p class="muted">saved/tracked toward ${money(target)} of goals</p><div class="progress"><i style="width:${Math.min(100,pct)}%"></i></div><div class="goal-progress-label"><span>${goals.length} active goal${goals.length===1?"":"s"}</span><span>${pct.toFixed(0)}%</span></div>`;
}
function renderSettings(){
  $("#reserveAmount").value=num(getSettings().reserveAmount).toFixed(2);if(mode==="local")$("#dataModeText").textContent="You are in local test mode. Data stays only in this browser until Firebase is configured.";
  const flags=state.reviewFlags||[],list=$("#reviewFlagsList");if(list)list.innerHTML=flags.length?flags.map(f=>`<div class="list-row"><div class="list-main"><strong>${escapeHTML(f.type==="possible_duplicate"?"Possible duplicate from ledger":"Review item")}</strong><span>${escapeHTML(f.account||"")} ${f.category?`• ${escapeHTML(f.category)}`:""} ${f.amount!==undefined?`• ${money(f.amount)}`:""} ${f.rows?`• rows ${f.rows.join(", ")}`:""}</span></div></div>`).join(""):empty("No import review flags.");const status=$("#importStatus");if(status&&state.transactions.length)status.textContent=`Current books: ${state.accounts.length} accounts • ${state.transactions.length.toLocaleString()} entries • ${state.debts.length} debts`;
}
function renderAll(){renderDashboard();renderLedger();renderCalendar();renderBills();renderDebts();renderAccounts();renderReports();renderGoals();renderSettings();}

function showView(name){
  $$(".view").forEach(v=>v.classList.toggle("active",v.id===`${name}View`));
  $$('[data-view]').forEach(b=>b.classList.toggle("active",b.dataset.view===name));
  const titles={dashboard:"Home",ledger:"Checkbook",calendar:"Money Calendar",bills:"Bills",debts:"Debt Center",accounts:"Accounts & Income",reports:"Reports",goals:"Goals & Money Tasks",settings:"Settings"};
  setText("#viewTitle",titles[name]||"Money HQ");
  if(name==="calendar")renderCalendar();if(name==="reports")renderReports();
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
function openPayBill(b,mk=monthKey()){
  const due=dueDateForMonth(b,mk);
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
    <label>Starting balance for progress<input name="startingBalance" type="number" min="0" step="0.01" value="${d.startingBalance??d.balance??""}"></label>
    <label>APR %<input name="apr" type="number" min="0" step="0.01" value="${d.apr??""}"></label>
    <label>Minimum payment<input name="minimumPayment" type="number" min="0" step="0.01" value="${d.minimumPayment??""}"></label>
    <label>Credit limit (cards only)<input name="limit" type="number" min="0" step="0.01" value="${d.limit??""}"></label>
    <label>Due day<input name="dueDay" type="number" min="1" max="31" value="${d.dueDay??""}" placeholder="Needs setup"></label>
    <div class="span-2 button-row"><button class="primary">Save debt</button>${d.id?`<button type="button" class="danger" id="deleteDebt">Delete</button>`:""}</div>
  </form>`;
}
function openDebt(d={}){
  openModal(d.id?"Edit debt":"Add debt",debtForm(d),"DEBT CENTER");
  $("#debtForm").addEventListener("submit",async e=>{e.preventDefault();const x=Object.fromEntries(new FormData(e.target));await store.save("debts",{...x,id:x.id||undefined,balance:num(x.balance),startingBalance:x.startingBalance===""?num(x.balance):Math.max(num(x.startingBalance),num(x.balance)),apr:x.apr===""?null:num(x.apr),minimumPayment:x.minimumPayment===""?null:num(x.minimumPayment),limit:x.limit===""?null:num(x.limit),dueDay:x.dueDay===""?null:num(x.dueDay),needsReview:false});closeModal();toast("Debt saved.");});
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
function receiveIncome(i,occurrenceDate=null){
  const suggestedDate=occurrenceDate||i.nextDate||todayISO();
  openModal(`Receive ${i.name}`,`<form id="receiveIncomeForm" class="stack">
    <label>Date received<input name="date" type="date" value="${suggestedDate}" required></label>
    <label>Actual amount<input name="amount" type="number" min="0" step="0.01" value="${i.amount}" required></label>
    <label>Deposit account<select name="accountId">${accountOptions(i.accountId)}</select></label>
    <button class="primary">Add to checkbook</button>
  </form>`,"INCOME");
  $("#receiveIncomeForm").addEventListener("submit",async e=>{e.preventDefault();const x=Object.fromEntries(new FormData(e.target));
    await store.save("transactions",{date:x.date,type:"income",payee:i.name,amount:Math.abs(num(x.amount)),accountId:x.accountId,category:"Income",note:"Scheduled income"});
    let next=i.nextDate||x.date,guard=0;while(next<=x.date&&guard++<1000)next=advanceDate(next,i.frequency);
    await store.save("incomeSchedules",{...i,nextDate:next});
    closeModal();toast("Income recorded and next payday advanced.");
  });
}


function goalForm(g={}){return `<form id="goalForm" class="form-grid"><input type="hidden" name="id" value="${g.id||""}"><label class="span-2">Goal name<input name="name" value="${escapeHTML(g.name||"")}" placeholder="Emergency fund, Latvia, car repairs…" required></label><label>Emoji<input name="emoji" value="${escapeHTML(g.emoji||"🎯")}" maxlength="8"></label><label>Target amount<input name="targetAmount" type="number" min="0" step="0.01" value="${g.targetAmount??""}" required></label><label>Already saved / tracked<input name="currentAmount" type="number" min="0" step="0.01" value="${g.currentAmount??0}"></label><label>Target date<input name="dueDate" type="date" value="${g.dueDate||""}"></label><label class="span-2">Note<textarea name="note" rows="2">${escapeHTML(g.note||"")}</textarea></label><div class="span-2 button-row"><button class="primary">Save goal</button>${g.id?`<button type="button" class="danger" id="deleteGoal">Delete</button>`:""}</div></form>`;}
function openGoal(g={}){openModal(g.id?"Edit goal":"Add a money goal",goalForm(g),"GOALS");$("#goalForm").addEventListener("submit",async e=>{e.preventDefault();const x=Object.fromEntries(new FormData(e.target));await store.save("goals",{...x,id:x.id||undefined,targetAmount:num(x.targetAmount),currentAmount:num(x.currentAmount)});closeModal();toast("Goal saved.");});$("#deleteGoal")?.addEventListener("click",async()=>{if(confirm("Delete this goal?")){await store.remove("goals",g.id);closeModal();}});}
function addGoalMoney(g){openModal(`Update ${g.name}`,`<form id="goalMoneyForm" class="stack"><p class="muted">Current progress: <strong>${money(g.currentAmount)}</strong> of ${money(g.targetAmount)}</p><label>Amount to add<input name="amount" type="number" step="0.01" required></label><p class="tiny muted">This updates the goal tracker only. If you actually moved cash to savings, record that transfer in the Checkbook too.</p><button class="primary">Update progress</button></form>`,"GOAL PROGRESS");$("#goalMoneyForm").addEventListener("submit",async e=>{e.preventDefault();const x=Object.fromEntries(new FormData(e.target));await store.save("goals",{...g,currentAmount:Math.max(0,num(g.currentAmount)+num(x.amount))});closeModal();toast("Goal progress updated ✨");});}
function taskForm(t={}){return `<form id="taskForm" class="form-grid"><input type="hidden" name="id" value="${t.id||""}"><label class="span-2">Task<input name="title" value="${escapeHTML(t.title||"")}" placeholder="Call Discover about APR…" required></label><label>Due date<input name="dueDate" type="date" value="${t.dueDate||""}"></label><label>Status<select name="completed"><option value="false" ${!t.completed?"selected":""}>To do</option><option value="true" ${t.completed?"selected":""}>Done</option></select></label><label class="span-2">Note<textarea name="note" rows="2">${escapeHTML(t.note||"")}</textarea></label><div class="span-2 button-row"><button class="primary">Save task</button>${t.id?`<button type="button" class="danger" id="deleteTask">Delete</button>`:""}</div></form>`;}
function openMoneyTask(t={}){openModal(t.id?"Edit money task":"Add money task",taskForm(t),"MONEY TO-DO");$("#taskForm").addEventListener("submit",async e=>{e.preventDefault();const x=Object.fromEntries(new FormData(e.target));await store.save("moneyTasks",{...x,id:x.id||undefined,completed:x.completed==="true"});closeModal();toast("Task saved.");});$("#deleteTask")?.addEventListener("click",async()=>{if(confirm("Delete this task?")){await store.remove("moneyTasks",t.id);closeModal();}});}
async function toggleTask(id){const t=state.moneyTasks.find(x=>x.id===id);if(t)await store.save("moneyTasks",{...t,completed:!t.completed});}
function openGuardrail(category="",existing=null){const t=existing||targetForCategory(category)||{};openModal(t.id?"Edit spending guardrail":"Add spending guardrail",`<form id="guardrailForm" class="stack"><label>Category<select name="category">${categoryOptions(t.category||category||"Groceries")}</select></label><label>Monthly target<input name="amount" type="number" min="0" step="1" value="${t.amount??""}" required></label><div class="button-row"><button class="primary">Save guardrail</button>${t.id?`<button type="button" class="danger" id="deleteGuardrail">Delete</button>`:""}</div></form>`,"SPENDING GUARDRAIL");$("#guardrailForm").addEventListener("submit",async e=>{e.preventDefault();const x=Object.fromEntries(new FormData(e.target));await store.save("categoryTargets",{id:t.id||undefined,category:x.category,amount:num(x.amount)});closeModal();toast("Guardrail saved.");});$("#deleteGuardrail")?.addEventListener("click",async()=>{if(confirm("Delete this guardrail?")){await store.remove("categoryTargets",t.id);closeModal();}});}
function openMerchantInsight(name){const tx=state.transactions.filter(t=>(t.payee||"").toLowerCase()===name.toLowerCase()&&t.type!=="transfer");const spentByMonth={};for(const t of tx){const mk=(t.date||"").slice(0,7);if(!mk)continue;spentByMonth[mk]=(spentByMonth[mk]||0)+(t.type==="expense"?Math.abs(Math.min(0,num(t.amount))):t.type==="refund"?-Math.max(0,num(t.amount)):0);}const total=Math.max(0,Object.values(spentByMonth).reduce((s,v)=>s+v,0)),months=Object.entries(spentByMonth).sort((a,b)=>b[0].localeCompare(a[0]));openModal(name,`<div class="stack"><div class="metric metric-peach"><span>Total recorded spending</span><strong>${money(total)}</strong><small>${tx.length} matching entries</small></div>${months.length?months.map(([mk,v])=>`<div class="planner-line"><span>${new Date(`${mk}-01T12:00:00`).toLocaleDateString("en-US",{month:"long",year:"numeric"})}</span><strong>${money(Math.max(0,v))}</strong></div>`).join(""):empty("No spending entries for this payee.")}</div>`,"MERCHANT INSIGHT");}

async function importMoneyHQFile(file){
  const text=await file.text(); let data;
  try{data=JSON.parse(text);}catch{throw new Error("That file is not valid JSON.");}
  if(!data || !Array.isArray(data.transactions) || !Array.isArray(data.accounts)) throw new Error("This is not a Money HQ import file.");
  const names=["accounts","transactions","bills","billPayments","debts","incomeSchedules","settings","reviewFlags","goals","moneyTasks","categoryTargets"];
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
function fullBackup(){downloadFile(`money-hq-v3-backup-${todayISO()}.json`,JSON.stringify({exportedAt:new Date().toISOString(),...state},null,2),"application/json");}

function wireEvents(){
  setText("#todayLabel",new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"}));
  $("#ledgerMonth").value=monthKey();$("#reportMonth").value=monthKey();calendarCursor=new Date();
  document.addEventListener("click",async e=>{
    const view=e.target.closest("[data-view]");if(view){showView(view.dataset.view);return;}
    const go=e.target.closest("[data-go]");if(go){showView(go.dataset.go);return;}
    if(e.target.closest("#quickAddBtn,#addTransactionBtn"))return openTransaction();
    if(e.target.closest("#addBillBtn,#calendarAddBill"))return openBill();
    if(e.target.closest("#addDebtBtn"))return openDebt();
    if(e.target.closest("#addAccountBtn"))return openAccount();
    if(e.target.closest("#addIncomeBtn"))return openIncome();
    if(e.target.closest("#addGoalBtn"))return openGoal();
    if(e.target.closest("#addMoneyTaskBtn"))return openMoneyTask();
    if(e.target.closest("#addGuardrailBtn"))return openGuardrail();
    if(e.target.closest("#runSimulatorBtn"))return renderSimulator();
    if(e.target.closest("#prevCalendarMonth")){calendarCursor.setMonth(calendarCursor.getMonth()-1);return renderCalendar();}
    if(e.target.closest("#nextCalendarMonth")){calendarCursor.setMonth(calendarCursor.getMonth()+1);return renderCalendar();}
    if(e.target.closest("#todayCalendarBtn")){calendarCursor=new Date();return renderCalendar();}
    const merchant=e.target.closest("[data-merchant]");if(merchant)return openMerchantInsight(merchant.dataset.merchant);
    const tx=e.target.closest("[data-edit-tx]");if(tx)return openTransaction(state.transactions.find(x=>x.id===tx.dataset.editTx));
    const eb=e.target.closest("[data-edit-bill]");if(eb)return openBill(state.bills.find(x=>x.id===eb.dataset.editBill));
    const pb=e.target.closest("[data-pay-bill]");if(pb)return openPayBill(state.bills.find(x=>x.id===pb.dataset.payBill),pb.dataset.billMonth||monthKey());
    const up=e.target.closest("[data-unpay-bill]");if(up){const b=state.bills.find(x=>x.id===up.dataset.unpayBill),mk=up.dataset.billMonth||monthKey(),pid=paymentKey(b.id,mk);if(confirm("Mark this bill unpaid again? Any checkbook entry created by that payment will also be removed.")){const linked=state.transactions.filter(t=>t.billPaymentId===pid);for(const t of linked)await store.remove("transactions",t.id);await store.remove("billPayments",pid);}return;}
    const ed=e.target.closest("[data-edit-debt]");if(ed)return openDebt(state.debts.find(x=>x.id===ed.dataset.editDebt));
    const pd=e.target.closest("[data-pay-debt]");if(pd)return openDebtPayment(state.debts.find(x=>x.id===pd.dataset.payDebt));
    const ea=e.target.closest("[data-edit-account]");if(ea)return openAccount(state.accounts.find(x=>x.id===ea.dataset.editAccount));
    const rc=e.target.closest("[data-reconcile]");if(rc)return openReconcile(state.accounts.find(x=>x.id===rc.dataset.reconcile));
    const ei=e.target.closest("[data-edit-income]");if(ei)return openIncome(state.incomeSchedules.find(x=>x.id===ei.dataset.editIncome));
    const ri=e.target.closest("[data-receive-income]");if(ri)return receiveIncome(state.incomeSchedules.find(x=>x.id===ri.dataset.receiveIncome),ri.dataset.incomeDate||null);
    const eg=e.target.closest("[data-edit-goal]");if(eg)return openGoal(state.goals.find(x=>x.id===eg.dataset.editGoal));
    const ag=e.target.closest("[data-add-goal-money]");if(ag)return addGoalMoney(state.goals.find(x=>x.id===ag.dataset.addGoalMoney));
    const tt=e.target.closest("[data-toggle-task]");if(tt)return toggleTask(tt.dataset.toggleTask);
    const et=e.target.closest("[data-edit-task]");if(et)return openMoneyTask(state.moneyTasks.find(x=>x.id===et.dataset.editTask));
    const tg=e.target.closest("[data-target-category]");if(tg)return openGuardrail(tg.dataset.targetCategory);
  });
  $("#closeModal").addEventListener("click",closeModal);$("#modal").addEventListener("click",e=>{if(e.target===$("#modal"))closeModal();});
  ["ledgerSearch","ledgerAccountFilter","ledgerCategoryFilter","ledgerTypeFilter","ledgerMonth"].forEach(id=>$("#"+id).addEventListener("input",renderLedger));
  $("#reportMonth").addEventListener("input",renderReports);$("#simExtra").addEventListener("input",renderSimulator);
  $("#exportCsvBtn").addEventListener("click",exportCSV);$("#backupBtn").addEventListener("click",fullBackup);
  $("#importLedgerBtn")?.addEventListener("click",async()=>{const file=$("#importLedgerFile")?.files?.[0];if(!file){toast("Choose the private Money HQ import JSON first.");return;}try{await importMoneyHQFile(file);}catch(err){toast(err.message);}});
  $("#settingsForm").addEventListener("submit",async e=>{e.preventDefault();await store.save("settings",{...getSettings(),id:"main",reserveAmount:num($("#reserveAmount").value)});toast("Protected cash updated.");});
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
