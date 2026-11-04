'use client';
import {useEffect,useRef,useState} from 'react';
type MarketingApi={mountMarketing:(element:HTMLElement)=>()=>void};
declare global {interface Window {CompanyMemoryMarketing?:MarketingApi}}
export default function MarketingHome(){
 const root=useRef<HTMLElement>(null);const [error,setError]=useState(false);
 useEffect(()=>{let disposed=false;let unmount:(()=>void)|undefined;const mount=()=>{if(!disposed&&root.current&&window.CompanyMemoryMarketing){unmount=window.CompanyMemoryMarketing.mountMarketing(root.current)}};const fail=()=>{if(!disposed)setError(true)};
  if(window.CompanyMemoryMarketing){mount();return()=>{disposed=true;unmount?.()}}
  let script=document.querySelector<HTMLScriptElement>('#company-memory-marketing');const fresh=!script;if(!script){script=document.createElement('script');script.id='company-memory-marketing';script.src='/marketing/marketing.js';script.async=true}script.addEventListener('load',mount);script.addEventListener('error',fail);if(fresh)document.body.append(script);
  return()=>{disposed=true;script?.removeEventListener('load',mount);script?.removeEventListener('error',fail);unmount?.()};
 },[]);
 return <div className="marketing-shell"><link rel="stylesheet" href="/marketing/style.css"/><a className="skip-link" href="#marketing-content">Skip to content</a><main id="marketing-content" ref={root}/>{error?<p role="alert">The introduction could not load. <a href="/app">Open the evidence dashboard</a>.</p>:null}<noscript><p>Company Memory keeps source-backed company decisions available across agent contexts. <a href="/app">Open the evidence dashboard</a>.</p></noscript></div>;
}
