export interface BinanceMarketData {
  predictedFundingRate: number;
  openInterest: number;
  orderBookBidDepthSL: number;
}

interface BinancePremiumIndexResponse { lastFundingRate: string; }
interface BinanceOpenInterestResponse { openInterest: string; }
interface BinanceDepthResponse { bids: Array<[string,string]>; }

const API='https://fapi.binance.com';

async function getJson<T>(path:string,params:Record<string,string>):Promise<T>{ const u=new URL(path,API); Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,v)); const r=await fetch(u.toString()); if(!r.ok) throw new Error(String(r.status)); return await r.json() as T; }
const num=(v:string)=>Number.isFinite(Number(v))?Number(v):0;

export async function fetchBinanceMarketData(symbol:string,stopLossPrice:number):Promise<BinanceMarketData>{
 const [f,oi,d]=await Promise.allSettled([
 getJson<BinancePremiumIndexResponse>('/fapi/v1/premiumIndex',{symbol}),
 getJson<BinanceOpenInterestResponse>('/fapi/v1/openInterest',{symbol}),
 getJson<BinanceDepthResponse>('/fapi/v1/depth',{symbol,limit:'50'})]);
 let depth=0;
 if(d.status==='fulfilled'){for(const [p,q] of d.value.bids){const price=num(p); const qty=num(q); if(price>=stopLossPrice) depth+=price*qty;}}
 return {predictedFundingRate:f.status==='fulfilled'?num(f.value.lastFundingRate):0,openInterest:oi.status==='fulfilled'?num(oi.value.openInterest):0,orderBookBidDepthSL:depth};
}