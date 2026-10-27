export function formatTokens(value){
 if(!Number.isFinite(value)||value<0)return '—';
 const scale=value>=1e9?1e9:1e6,unit=scale===1e9?'B':'M';
 return (value/scale).toLocaleString('en-US',{maximumFractionDigits:value>0&&value<1e6?6:2})+unit;
}
export function formatUsd(value){
 if(!Number.isFinite(value)||value<0)return '—';
 if(value>0&&value<.0001)return '<$0.0001';
 return '$'+value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4});
}
