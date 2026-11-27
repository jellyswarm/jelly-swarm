(()=>{const reduced=matchMedia('(prefers-reduced-motion: reduce)');let leaving=false;
function navigate(href){if(leaving)return;leaving=true;if(reduced.matches){location.assign(href);return}document.body.classList.add('page-leaving');setTimeout(()=>location.assign(href),180)}
window.jellyNavigate=navigate;addEventListener('pageshow',()=>{leaving=false;document.body.classList.remove('page-leaving')});
document.addEventListener('click',e=>{const a=e.target.closest('a[href]');if(!a||e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||a.target||a.hasAttribute('download'))return;const u=new URL(a.href,location.href);if(u.origin!==location.origin||!/^(https?:|file:)$/.test(u.protocol)||u.pathname===location.pathname)return;e.preventDefault();navigate(a.href)});
})();
