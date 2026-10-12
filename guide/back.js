// Nút "Quay lại" của trang hướng dẫn: quay về trang vừa mở (nếu có), không thì về trang chính (href mặc định).
(function () {
  var a = document.getElementById('web-back');
  if (!a) return;
  a.addEventListener('click', function (ev) { if (window.history.length > 1) { ev.preventDefault(); window.history.back(); } });
})();
