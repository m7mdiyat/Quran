import{j as r}from"./index-DOW9YNgO.js";const s="m7_app_banner_dismissed",o=30,c=900,a={os:"ios",url:"https://apps.apple.com/app/id6779788235"},l={os:"android",url:"https://play.google.com/store/apps/details?id=com.m7mdiyat.quran"};function p(){const n=navigator.userAgent||"";return/android/i.test(n)?l:/iphone|ipad|ipod/i.test(n)||/macintosh/i.test(n)&&(navigator.maxTouchPoints||0)>1?a:null}function u(){try{const n=localStorage.getItem(s);if(!n)return!1;const e=Number(n);return Number.isFinite(e)?Date.now()-e<o*24*60*60*1e3:!1}catch{return!1}}function i(){try{localStorage.setItem(s,String(Date.now()))}catch{}}let t=null;function d(n){return n==="ios"?'<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.365 1.43c0 1.14-.42 2.2-1.12 3-.78.9-2.06 1.6-3.1 1.52-.13-1.1.43-2.27 1.1-3.02.78-.88 2.13-1.53 3.12-1.5zM20.9 17.1c-.5 1.16-.74 1.68-1.39 2.7-.9 1.43-2.18 3.2-3.76 3.22-1.4.02-1.76-.92-3.66-.9-1.9.01-2.3.92-3.7.9-1.58-.02-2.79-1.62-3.7-3.04-2.53-3.98-2.8-8.65-1.24-11.13 1.11-1.76 2.86-2.79 4.5-2.79 1.68 0 2.73.92 4.12.92 1.35 0 2.17-.92 4.11-.92 1.47 0 3.02.8 4.13 2.18-3.63 1.99-3.04 7.17.29 8.86z"/></svg>':'<svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true"><path d="M325.3 234.3 104.6 13l280.8 161.2-60.1 60.1zM47 0C34 6.8 25.3 19.2 25.3 35.3v441.3c0 16.1 8.7 28.5 21.7 35.3l256.6-256L47 0zm425.2 225.6-58.9-34.1-65.7 64.5 65.7 64.5 60.1-34.1c18-14.3 18-46.5-1.2-60.8zM104.6 499l280.8-161.2-60.1-60.1L104.6 499z"/></svg>'}function m(n){const e=document.createElement("div");return e.className="m7-app-banner",e.setAttribute("role","region"),e.setAttribute("aria-label","تحميل التطبيق"),e.innerHTML=`
    <div class="m7-app-banner__inner">
      <span class="m7-app-banner__icon" aria-hidden="true">
        <img src="/favicon.svg" alt="" width="40" height="40" />
      </span>
      <span class="m7-app-banner__text">
        <span class="m7-app-banner__title">حمّل تطبيق محمديات</span>
        <span class="m7-app-banner__sub">أسرع، ويعمل بدون إنترنت</span>
      </span>
      <a class="m7-app-banner__cta" href="${n.url}" target="_blank" rel="noopener">
        ${d(n.os)}<span>تحميل</span>
      </a>
      <button type="button" class="m7-app-banner__close" aria-label="إغلاق">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>`,e.querySelector(".m7-app-banner__close").addEventListener("click",()=>f()),e.querySelector(".m7-app-banner__cta").addEventListener("click",()=>i()),e}function f(){if(i(),!t)return;const n=t;t=null,n.classList.remove("m7-app-banner--in");const e=()=>n.remove();n.addEventListener("transitionend",e,{once:!0}),setTimeout(e,600)}function b(){if(typeof window>"u"||typeof document>"u"||r()||document.documentElement.classList.contains("is-app"))return;const n=p();if(!n||u())return;const e=m(n);document.body.appendChild(e),setTimeout(()=>{if(r()){e.remove();return}t=e,e.offsetHeight,e.classList.add("m7-app-banner--in")},c)}export{b as initAppBanner};
