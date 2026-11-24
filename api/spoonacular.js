/*
  Vercel 서버 함수: /api/spoonacular
  - 브라우저는 이 함수만 호출하고, Spoonacular 키는 서버 환경변수 SPOONACULAR_API_KEY에서만 읽는다.
  - 약관상 재료·조리법은 저장할 수 없으므로 이 함수는 아무것도 저장하거나 캐시하지 않는다.
  - action=search&q=...&offset=0   샐러드 검색 (id, title, image만 돌려준다)
  - action=detail&id=123           레시피 상세 (재료, 조리 단계, 원문 출처)
*/
const BASE = 'https://api.spoonacular.com';

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function call(path, params, key) {
  const url = new URL(BASE + path);
  Object.keys(params).forEach((k) => url.searchParams.set(k, String(params[k])));
  let r;
  try {
    r = await fetch(url, { headers: { 'x-api-key': key } });
  } catch (_) {
    throw new ApiError(502, 'Spoonacular에 연결하지 못했습니다.');
  }
  const left = r.headers.get('x-api-quota-left');
  if (r.status === 401 || r.status === 403) throw new ApiError(500, 'Spoonacular 키가 올바르지 않습니다. Vercel 환경변수를 확인해 주세요.');
  if (r.status === 402) throw new ApiError(429, '오늘 무료 호출 한도(50포인트)를 모두 썼습니다. 내일 다시 시도해 주세요.');
  if (r.status === 429) throw new ApiError(429, '요청이 너무 빠릅니다. 잠시 뒤 다시 시도해 주세요.');
  if (!r.ok) throw new ApiError(502, 'Spoonacular 응답 오류(' + r.status + ')입니다.');
  return { data: await r.json(), left: left === null ? null : Number(left) };
}

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET 요청만 지원합니다.' });

  const key = process.env.SPOONACULAR_API_KEY;
  if (!key) return res.status(500).json({ error: '서버에 SPOONACULAR_API_KEY가 설정되어 있지 않습니다.' });

  const q = req.query || {};
  try {
    if (q.action === 'search') {
      const text = String(q.q || '').trim().slice(0, 60);
      const offset = Math.min(Math.max(parseInt(q.offset, 10) || 0, 0), 900);
      const params = { type: 'salad', number: 10, offset };
      if (text) params.query = text;
      const { data, left } = await call('/recipes/complexSearch', params, key);
      return res.status(200).json({
        total: Number(data.totalResults) || 0,
        quotaLeft: left,
        results: (data.results || []).map((x) => ({ id: x.id, title: String(x.title || ''), image: x.image || null }))
      });
    }

    if (q.action === 'detail') {
      const id = String(q.id || '');
      if (!/^\d{1,9}$/.test(id)) return res.status(400).json({ error: '레시피 번호가 올바르지 않습니다.' });
      const { data: d, left } = await call('/recipes/' + id + '/information', { includeNutrition: 'false' }, key);

      let steps = [];
      (d.analyzedInstructions || []).forEach((g) => (g.steps || []).forEach((s) => { if (s && s.step) steps.push(String(s.step)); }));
      if (!steps.length && d.instructions) steps = [stripHtml(d.instructions)];

      const ingredients = (d.extendedIngredients || []).map((i) => {
        const m = i.measures && i.measures.metric;
        return {
          name: String(i.name || i.originalName || ''),
          amount: Number(m ? m.amount : i.amount) || 0,
          unit: String((m ? (m.unitShort || m.unitLong) : i.unit) || ''),
          original: String(i.original || '')
        };
      });

      return res.status(200).json({
        quotaLeft: left,
        id: d.id,
        title: String(d.title || ''),
        image: d.image || null,
        minutes: Number(d.readyInMinutes) || null,
        servings: Number(d.servings) || null,
        sourceName: String(d.sourceName || ''),
        sourceUrl: d.sourceUrl || d.spoonacularSourceUrl || '',
        ingredients,
        steps
      });
    }

    return res.status(400).json({ error: 'action은 search 또는 detail이어야 합니다.' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || '알 수 없는 오류입니다.' });
  }
};
