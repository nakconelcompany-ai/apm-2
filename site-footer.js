(function () {
  var footer = document.querySelector('footer');
  if (!footer) return;

  var style = document.createElement('style');
  style.textContent = '' +
    '.apm-site-footer{background:#fff!important;color:#111827!important;padding:48px 0 28px!important;border-top:1px solid #e5e7eb!important;text-align:left!important;font-family:Manrope,Arial,sans-serif!important}' +
    '.apm-site-footer .apm-footer-wrap{width:min(1160px,calc(100% - 40px));margin:0 auto}' +
    '.apm-site-footer .apm-footer-top{display:flex;flex-wrap:wrap;gap:34px;justify-content:space-between;align-items:flex-start}' +
    '.apm-site-footer .apm-footer-brand{display:flex;gap:14px;align-items:center;color:#111827;text-decoration:none}' +
    '.apm-site-footer .apm-footer-brand img{width:54px!important;height:54px!important;border-radius:50%!important;object-fit:contain}' +
    '.apm-site-footer .apm-footer-name{font-weight:800;font-size:19px;color:#008751;letter-spacing:-.02em}' +
    '.apm-site-footer .apm-footer-tagline{font-size:13px;color:#6b7280;font-style:italic}' +
    '.apm-site-footer .apm-footer-column h4{font-size:13.5px;margin:0 0 12px;color:#0052cc;font-weight:800}' +
    '.apm-site-footer .apm-footer-column a,.apm-site-footer .apm-footer-column p{display:block;color:#374151;text-decoration:none;font-size:15px;margin:0 0 8px}' +
    '.apm-site-footer .apm-footer-column a:hover{color:#0052cc}' +
    '.apm-site-footer .apm-footer-bottom{margin-top:36px;padding-top:20px;border-top:1px solid #e5e7eb;display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between;font-size:13.5px;color:#6b7280}' +
    '@media(max-width:600px){.apm-site-footer{padding:38px 0 24px!important}.apm-site-footer .apm-footer-wrap{width:min(100% - 32px,1160px)}.apm-site-footer .apm-footer-top{gap:26px}.apm-site-footer .apm-footer-bottom{margin-top:28px;flex-direction:column}}';
  document.head.appendChild(style);

  footer.className = 'apm-site-footer';
  footer.innerHTML = '<div class="apm-footer-wrap">' +
    '<div class="apm-footer-top">' +
      '<a class="apm-footer-brand" href="/" aria-label="APM4OYO home">' +
        '<img src="apm%20logo.jfif" alt="APM4OYO logo">' +
        '<span><span class="apm-footer-name">APM 2027</span><br><span class="apm-footer-tagline">Allied People’s Movement for a stronger Oyo.</span></span>' +
      '</a>' +
      '<div class="apm-footer-column"><h4>Explore</h4><a href="/">Home</a><a href="/our-promises">Our Promises</a><a href="/#register">Join the APM4OYO Network</a></div>' +
      '<div class="apm-footer-column"><h4>APM4OYO</h4><p>Oyo State, Nigeria</p></div>' +
    '</div>' +
    '<div class="apm-footer-bottom"><span>© ' + new Date().getFullYear() + ' APM 2027. All rights reserved.</span><span>Connect · Listen · Empower · Engage</span></div>' +
  '</div>';
})();
