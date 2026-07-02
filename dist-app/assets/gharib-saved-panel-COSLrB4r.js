import{m as f,n as S,o as H,p as T,q as E,r as x}from"./index-BAj1pWZg.js";let a=null,h=!1,_=!1,o=!1,v=!1,l=0;const $=()=>{try{return window.matchMedia("(prefers-reduced-motion: reduce)").matches}catch{return!1}},q=`
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10.7 3.2a1.55 1.55 0 0 1 2.6 0"/>
    <path d="M9.1 6.6c.3-1.7 1.4-2.6 2.9-2.6s2.6.9 2.9 2.6"/>
    <path d="M8.3 6.6h7.4"/>
    <path d="M9.2 6.6l-.5 7.2a1.3 1.3 0 0 0 1.3 1.4h4a1.3 1.3 0 0 0 1.3-1.4l-.5-7.2"/>
    <path class="gharib-saved-btn__flame" d="M12.4 7.4c-1.4 1.7-2.4 2.9-2.4 4.4a2 2 0 0 0 4 0c0-1-.4-1.9-1-2.9.2.7.1 1.2-.2 1.6.5-1.2.3-2.3-.4-3.1z"/>
    <path d="M10.4 15.2l-.6 2.9M13.6 15.2l.6 2.9"/>
    <path d="M9.6 18.1h4.8"/>
  </svg>`,A='<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3c2.6 3.1 4.4 5.5 4.4 8.6a4.4 4.4 0 0 1-8.8 0c0-1.2.4-2.3 1.1-3.4.4.6.9 1 1.6 1.1C9.6 7.6 10 5.2 12 3z"/></svg>',C='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7"/><path d="M10 11v6M14 11v6"/></svg>';function F(e){const t=Number(e).toLocaleString("ar-EG");return e===1?"كلمة واحدة":e===2?"كلمتان":e>=3&&e<=10?`${t} كلمات`:`${t} كلمة`}function R(){if(document.getElementById("offlinePanelFont"))return;const e=document.createElement("link");e.id="offlinePanelFont",e.rel="stylesheet",e.href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap",document.head.appendChild(e)}function g(e=""){return String(e).replace(/[&<>"']/g,t=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[t])}function B(e){return String(e).replace(/\.{2,}|…/g," … ").replace(/\s+/g," ").trim()}function w(){if(!a)return;const e=a.querySelector("[data-gh-list]"),t=a.querySelector("[data-gh-scroll]");if(!e||!t)return;const n=t.querySelector(".gharib-saved-scroll__thumb"),s=e.scrollHeight,r=e.clientHeight,i=s-r,u=t.clientHeight;if(i<=1||r<=0||u<=0){t.classList.remove("is-active");return}const m=Math.min(u,Math.max(22,Math.round(r/s*u))),y=Math.max(0,u-m),k=Math.round(e.scrollTop/i*y);n&&(n.style.height=`${m}px`,n.style.transform=`translateY(${k}px)`),t.classList.add("is-active")}function G(){l||(l=requestAnimationFrame(()=>{l=0,w()}))}function d(){requestAnimationFrame(w)}function P(){if(a)return a;R();const e=document.createElement("div");e.id="gharibSavedSheet",e.className="offline-sheet offline-sheet--smooth",e.setAttribute("aria-hidden","true"),e.innerHTML=`
      <div class="offline-sheet__backdrop" data-gh-close></div>
      <div class="offline-sheet__card" role="dialog" aria-modal="true" aria-labelledby="gharibSavedTitle">
        <button type="button" class="offline-sheet__close" data-gh-close aria-label="إغلاق">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
        <div class="offline-sheet__head">
          <div class="offline-sheet__icon" aria-hidden="true">${q}</div>
          <h2 id="gharibSavedTitle" class="offline-sheet__title">غريب القرآن</h2>
          <p class="offline-sheet__desc">هنا تجتمع كلمات القرآن الغريبة التي تعلّمت معناها. كلما <span class="gharib-saved-tadabbur">أضأت</span> كلمةً وفهمتها، أُضيفت إلى حصيلتك في هذه القائمة.</p>
          <div class="gharib-saved-meta" data-gh-meta></div>
        </div>
        <div class="gharib-saved-listwrap">
          <!-- Rail FIRST so it lands on the RIGHT in the panel's RTL flex row;
               the list takes the rest of the width to its left. -->
          <div class="gharib-saved-scroll" data-gh-scroll aria-hidden="true"><div class="gharib-saved-scroll__thumb"></div></div>
          <div class="gharib-saved-list" data-gh-list></div>
        </div>
      </div>`,document.body.appendChild(e),a=e,e.addEventListener("click",I);const t=e.querySelector("[data-gh-list]");return t&&t.addEventListener("scroll",G,{passive:!0}),e.addEventListener("pointerdown",n=>{v=!!n.target.closest(".offline-sheet__backdrop")}),e}function p(){return""}function j(e){const t=g(B(e.w)),n=e.m?g(E(e.m)):"";return`
      <div class="gharib-saved-row" data-gh-row data-key="${g(e.key)}">
        <div class="gharib-saved-row__gloss">
          <span class="gharib-saved-row__word">${t}</span>
          ${n?`<span class="gharib-saved-row__sep" aria-hidden="true">›</span><span class="gharib-saved-row__meaning">${n}</span>`:""}
        </div>
        <button type="button" class="gharib-saved-row__remove" data-gh-remove aria-label="إزالة الكلمة">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>`}function c(e){const t=a?.querySelector("[data-gh-meta]");if(t){if(e<=0){t.innerHTML="",o=!1;return}if(o){t.innerHTML=`
          <div class="gharib-saved-confirm">
            <span class="gharib-saved-confirm__text">مسح كل الكلمات المحفوظة؟</span>
            <div class="gharib-saved-confirm__actions">
              <button type="button" class="offline-btn offline-btn--danger" data-gh-reset-confirm>نعم، امسح الكل</button>
              <button type="button" class="offline-btn offline-btn--ghost" data-gh-reset-cancel>إلغاء</button>
            </div>
          </div>`;return}t.innerHTML=`
      <span class="gharib-saved-count">${A}<span>${F(e)}</span></span>
      <button type="button" class="gharib-saved-reset" data-gh-reset aria-label="مسح كل الكلمات">
        ${C}<span>مسح الكل</span>
      </button>`}}async function L(){if(!a)return;const e=a.querySelector("[data-gh-list]");if(!e)return;if(f()===0){e.innerHTML=p(),c(0),d();return}if(e.innerHTML='<div class="gharib-saved-loading">…جارٍ جمع كلماتك</div>',await S(),!h)return;const t=H();c(t.length),e.innerHTML=t.length?t.map(j).join(""):p(),d()}function D(e,t){if(!x(t)){e.remove();return}c(f());const n=()=>{e.remove();const i=a?.querySelector("[data-gh-list]");i&&!i.querySelector(".gharib-saved-row")&&(i.innerHTML=p()),d()};if($()){n();return}e.style.maxHeight=`${e.scrollHeight}px`,e.offsetHeight,e.classList.add("gharib-saved-row--removing");let s=!1;const r=i=>{i&&i.target!==e||s||(s=!0,e.removeEventListener("transitionend",r),n())};e.addEventListener("transitionend",r),setTimeout(r,420)}function I(e){const t=e.target.closest("[data-gh-close]");if(t){const s=t.classList.contains("offline-sheet__backdrop"),r=v;if(v=!1,s&&!r)return;b();return}if(e.target.closest("[data-gh-reset]")){o=!0,c(f());return}if(e.target.closest("[data-gh-reset-cancel]")){o=!1,c(f());return}if(e.target.closest("[data-gh-reset-confirm]")){T(),o=!1,L();return}const n=e.target.closest("[data-gh-remove]");if(n){const s=n.closest("[data-gh-row]");s&&D(s,s.dataset.key)}}function M(e){e.key==="Escape"&&h&&b()}function V(){P(),h=!0,o=!1,v=!1,a.offsetWidth,a.classList.add("offline-sheet--open"),a.setAttribute("aria-hidden","false"),document.body.classList.add("offline-sheet-open"),L(),document.addEventListener("keydown",M),window.addEventListener("resize",d)}function b(){h=!1,a&&(a.classList.remove("offline-sheet--open"),a.setAttribute("aria-hidden","true")),document.body.classList.remove("offline-sheet-open"),document.removeEventListener("keydown",M),window.removeEventListener("resize",d),l&&(cancelAnimationFrame(l),l=0)}function N(){_||(_=!0,document.addEventListener("gharib:open-saved",()=>{h?b():V()}))}export{N as initGharibSavedPanel};
