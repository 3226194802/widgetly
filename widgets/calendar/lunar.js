// 农历封装：基于 lunar-javascript（6tail/lunar，MIT 免费商用，权威农历+节气数据）
// 依赖：先加载 lunar-lib.js；UMD 在 nodeIntegration 下走 CommonJS，故用 require 兜底
(function () {
  const Solar = (typeof window !== 'undefined' && window.Solar) || require('./lunar-lib.js').Solar;

  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];

  function toLunar(y, m, d) {
    const lunar = Solar.fromYmd(y, m, d).getLunar();
    return { lYear: lunar.getYear(), lMonth: Math.abs(lunar.getMonth()), lDay: lunar.getDay(), isLeap: lunar.getMonth() < 0 };
  }
  function lunarText(y, m, d) {
    return Solar.fromYmd(y, m, d).getLunar().getDayInChinese();
  }
  function moonPhase(y, m, d) {
    const l = toLunar(y, m, d);
    const phases = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
    return phases[Math.round(l.lDay / 30 * 8) % 8];
  }
  function weekOfYear(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dayNr = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dayNr + 3);
    const firstThursday = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round((d - firstThursday - (3 - ((firstThursday.getDay() + 6) % 7)) * 86400000) / 604800000);
  }
  function termsOfMonth(y, m) {
    const out = [];
    const days = new Date(y, m, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const jq = Solar.fromYmd(y, m, d).getLunar().getJieQi();
      if (jq) out.push({ name: jq, day: d });
    }
    return out;
  }

  window.LUNAR = { toLunar, lunarText, moonPhase, weekOfYear, termsOfMonth, dayNames };
})();
