import{j as k}from"./index-C_ShdAan.js";const M="m7_notes",p=5e3;let r=null;const m=new Set;let v=null,d=null,i=null,E={surah:null,ayah:null},L=!1,y=!1;function f(){if(r)return r;try{const t=localStorage.getItem(M);if(!t)return r={},r;const e=JSON.parse(t);if(e&&typeof e=="object")return r=e,r}catch{}return console.warn("[notes] corrupt m7_notes payload; treating as empty"),r={},r}function _(){try{localStorage.setItem(M,JSON.stringify(r||{}))}catch{}}function g(){for(const t of m)try{t()}catch{}}function z(t,e){return!!f()[`${t}:${e}`]}function O(t,e){return f()[`${t}:${e}`]||null}function P(){return Object.entries(f()).map(([t,e])=>{const[n,o]=t.split(":").map(Number);return{surah:n,ayah:o,...e}}).filter(t=>Number.isFinite(t.surah)&&Number.isFinite(t.ayah)).sort((t,e)=>(e.updated||0)-(t.updated||0))}function Q(){return new Set(Object.keys(f()))}function D(t,e,n){const o=(n||"").slice(0,p),s=`${t}:${e}`,h=Date.now(),l=f();if(!o){l[s]&&(delete l[s],_(),g());return}const c=l[s];l[s]={text:o,created:c?.created||h,updated:h},_(),g()}function x(t,e){const n=`${t}:${e}`,o=f();o[n]&&(delete o[n],_(),g())}function F(t){return m.add(t),()=>m.delete(t)}function j(){if(document.getElementById("offlinePanelFont"))return;const t=document.createElement("link");t.id="offlinePanelFont",t.rel="stylesheet",t.href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap",document.head.appendChild(t)}function I(){if(d)return d;j();const t=document.createElement("div");t.id="notesEditorSheet",t.className="offline-sheet",t.setAttribute("aria-hidden","true"),t.innerHTML=`
      <div class="offline-sheet__backdrop" data-note-close></div>
      <div class="offline-sheet__card" role="dialog" aria-modal="true" aria-labelledby="noteEditorTitle">
        <button type="button" class="offline-sheet__close" data-note-close aria-label="إغلاق">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
        <div class="offline-sheet__head">
          <div class="offline-sheet__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 20h9"/><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </div>
          <h2 id="noteEditorTitle" class="offline-sheet__title">ملاحظة</h2>
          <p class="offline-sheet__desc" data-note-ref>—</p>
        </div>
        <div class="notes-editor">
          <div class="notes-editor__ayah" data-note-ayah-text></div>
          <textarea class="feedback-input feedback-textarea notes-editor__textarea"
                    placeholder="اكتب ملاحظتك على هذه الآية..." rows="6" maxlength="${p}"></textarea>
          <div class="notes-editor__counter" aria-live="polite">0 / ${p}</div>
          <div class="notes-editor__actions">
            <button type="button" class="offline-btn offline-btn--primary" data-note-save>حفظ</button>
            <button type="button" class="offline-btn offline-btn--ghost offline-btn--danger-text" data-note-delete style="display:none;">حذف</button>
            <button type="button" class="offline-btn offline-btn--ghost" data-note-close>إلغاء</button>
          </div>
          <div class="notes-editor__hint">تُحفظ ملاحظاتك على هذا الجهاز فقط.</div>
        </div>
      </div>`,document.body.appendChild(t),d=t;const e=t.querySelector(".notes-editor__textarea"),n=t.querySelector(".notes-editor__counter");return e.addEventListener("input",()=>{n.textContent=`${e.value.length} / ${p}`}),t.addEventListener("click",o=>{if(o.target.closest("[data-note-close]")){b();return}if(o.target.closest("[data-note-save]")){R();return}if(o.target.closest("[data-note-delete]")){G();return}}),t}function K(t,e){if(!k())return;const n=Number(t),o=Number(e);if(!n||!o)return;I(),E={surah:n,ayah:o},L=!0;const s=d,h=s.querySelector("[data-note-ref]"),l=s.querySelector("[data-note-ayah-text]"),c=s.querySelector(".notes-editor__textarea"),S=s.querySelector(".notes-editor__counter"),N=s.querySelector("[data-note-delete]");if(h&&(h.textContent=`سورة ${H(n)} · آية ${o}`),l){const A=v?.getAyahPlainText?.(n,o)||"";l.textContent=A,l.style.display=A?"":"none"}const $=O(n,o);c&&(c.value=$?.text||""),S&&(S.textContent=`${c?.value.length||0} / ${p}`),N&&(N.style.display=$?"":"none"),s.classList.add("offline-sheet--open"),s.setAttribute("aria-hidden","false"),document.body.classList.add("offline-sheet-open"),setTimeout(()=>c?.focus(),60),document.addEventListener("keydown",C)}function b(){L=!1,d&&(d.classList.remove("offline-sheet--open"),d.setAttribute("aria-hidden","true")),document.body.classList.remove("offline-sheet-open"),document.removeEventListener("keydown",C)}function C(t){t.key==="Escape"&&L&&b()}function R(){const{surah:t,ayah:e}=E;if(!t||!e)return;const o=(d?.querySelector(".notes-editor__textarea")?.value||"").trim();o?(D(t,e,o),w("تم الحفظ")):(x(t,e),w("تم الحذف")),b()}function G(){const{surah:t,ayah:e}=E;!t||!e||(x(t,e),w("تم الحذف"),b())}function J(){if(i)return i;j();const t=document.createElement("div");return t.id="notesListSheet",t.className="offline-sheet",t.setAttribute("aria-hidden","true"),t.innerHTML=`
      <div class="offline-sheet__backdrop" data-notes-close></div>
      <div class="offline-sheet__card" role="dialog" aria-modal="true" aria-labelledby="notesListTitle">
        <button type="button" class="offline-sheet__close" data-notes-close aria-label="إغلاق">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
        <div class="offline-sheet__head">
          <div class="offline-sheet__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M8 8h8M8 12h8M8 16h5"/></svg>
          </div>
          <h2 id="notesListTitle" class="offline-sheet__title">تدبرياتي</h2>
          <p class="offline-sheet__desc">جميع ملاحظاتك المحفوظة على هذا الجهاز.</p>
        </div>
        <div class="notes-list" data-notes-list></div>
      </div>`,document.body.appendChild(t),i=t,t.addEventListener("click",e=>{if(e.target.closest("[data-notes-close]")){u();return}const n=e.target.closest("[data-note-row]");if(!n)return;const o=Number(n.dataset.s),s=Number(n.dataset.a);if(e.target.closest("[data-act-delete]")){x(o,s);return}if(e.target.closest("[data-act-edit]")){u(),K(o,s);return}if(e.target.closest("[data-act-jump]")){u(),v?.jumpToAyah?.(o,s);return}u(),v?.jumpToAyah?.(o,s)}),t}function q(){if(!i)return;const t=i.querySelector("[data-notes-list]");if(!t)return;const e=P();if(!e.length){t.innerHTML=`
          <div class="notes-list__empty">
            لا توجد ملاحظات بعد.<br/>اضغط مطولًا على آية في وضع التدبر ثم "ملاحظة" لإضافة واحدة.
          </div>`;return}t.innerHTML=e.map(n=>{const o=(n.text||"").slice(0,80).replace(/\s+/g," ").trim(),s=X(n.updated);return`
          <div class="notes-list__row" data-note-row data-s="${n.surah}" data-a="${n.ayah}" role="button" tabindex="0">
            <div class="notes-list__row-head">
              <span class="notes-list__row-ref">${H(n.surah)} · آية ${n.ayah}</span>
              <span class="notes-list__row-time">${s}</span>
            </div>
            <div class="notes-list__row-preview">${W(o)}${n.text.length>80?"…":""}</div>
            <div class="notes-list__row-actions">
              <button type="button" class="offline-btn offline-btn--primary" data-act-jump>اذهب للآية</button>
              <button type="button" class="offline-btn offline-btn--ghost" data-act-edit>تعديل</button>
              <button type="button" class="offline-btn offline-btn--ghost offline-btn--danger-text" data-act-delete>حذف</button>
            </div>
          </div>`}).join("")}function Z(){k()&&(J(),y=!0,q(),i.classList.add("offline-sheet--open"),i.setAttribute("aria-hidden","false"),document.body.classList.add("offline-sheet-open"),document.addEventListener("keydown",B))}function u(){y=!1,i&&(i.classList.remove("offline-sheet--open"),i.setAttribute("aria-hidden","true")),document.body.classList.remove("offline-sheet-open"),document.removeEventListener("keydown",B)}function B(t){t.key==="Escape"&&y&&u()}F(()=>{y&&q()});function V(t){if(!k())return;v=t||{};const e=document.getElementById("notesMenuBtn");e&&(e.style.display="",e.addEventListener("click",()=>{y?u():Z()}))}const U=["","الفاتحة","البقرة","آل عمران","النساء","المائدة","الأنعام","الأعراف","الأنفال","التوبة","يونس","هود","يوسف","الرعد","إبراهيم","الحجر","النحل","الإسراء","الكهف","مريم","طه","الأنبياء","الحج","المؤمنون","النور","الفرقان","الشعراء","النمل","القصص","العنكبوت","الروم","لقمان","السجدة","الأحزاب","سبأ","فاطر","يس","الصافات","ص","الزمر","غافر","فصلت","الشورى","الزخرف","الدخان","الجاثية","الأحقاف","محمد","الفتح","الحجرات","ق","الذاريات","الطور","النجم","القمر","الرحمن","الواقعة","الحديد","المجادلة","الحشر","الممتحنة","الصف","الجمعة","المنافقون","التغابن","الطلاق","التحريم","الملك","القلم","الحاقة","المعارج","نوح","الجن","المزمل","المدثر","القيامة","الإنسان","المرسلات","النبأ","النازعات","عبس","التكوير","الانفطار","المطففين","الانشقاق","البروج","الطارق","الأعلى","الغاشية","الفجر","البلد","الشمس","الليل","الضحى","الشرح","التين","العلق","القدر","البينة","الزلزلة","العاديات","القارعة","التكاثر","العصر","الهمزة","الفيل","قريش","الماعون","الكوثر","الكافرون","النصر","المسد","الإخلاص","الفلق","الناس"];function H(t){return U[t]||`سورة ${t}`}function W(t=""){return String(t).replace(/[&<>"']/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[e])}function X(t){if(!t)return"";try{return new Date(t).toLocaleDateString("ar-EG-u-nu-latn",{year:"numeric",month:"short",day:"numeric"})}catch{return""}}let a=null,T=null;function w(t){a||(a=document.querySelector(".copy-toast"),a||(a=document.createElement("div"),a.className="copy-toast",a.setAttribute("role","status"),a.setAttribute("aria-live","polite"),document.body.appendChild(a))),a.textContent=t,a.classList.remove("copy-toast--show"),a.offsetWidth,a.classList.add("copy-toast--show"),clearTimeout(T),T=setTimeout(()=>{a?.classList.remove("copy-toast--show")},1800)}export{x as deleteNote,P as getAllNotes,O as getNote,Q as getNoteKeysSet,z as hasNote,V as initNotesPanel,K as openNoteEditor,Z as openNotesList,D as saveNote,F as subscribeNotes};
