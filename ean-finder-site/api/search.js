const SOURCES = [
  { key: 'products', name: 'Open Products Facts', base: 'https://world.openproductsfacts.org' },
  { key: 'food', name: 'Open Food Facts', base: 'https://world.openfoodfacts.org' },
  { key: 'beauty', name: 'Open Beauty Facts', base: 'https://world.openbeautyfacts.org' },
  { key: 'pet', name: 'Open Pet Food Facts', base: 'https://world.openpetfoodfacts.org' }
];

const clean = (v='') => Array.isArray(v) ? v.filter(Boolean).join(', ') : String(v || '').replace(/\s+/g,' ').trim();
const first = (...vals) => vals.find(v => v !== undefined && v !== null && clean(v) !== '') || '';

function normalize(value='') {
  return String(value).replace(/\D/g,'');
}

function validGTIN(code) {
  if (![8,12,13,14].includes(code.length)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let i = digits.length - 1, pos = 0; i >= 0; i--, pos++) {
    sum += digits[i] * (pos % 2 === 0 ? 3 : 1);
  }
  return ((10 - (sum % 10)) % 10) === check;
}

async function get(url, {json=false, headers={}}={}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8500);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EAN-Finder/1.0)',
        'Accept': json ? 'application/json' : '*/*',
        ...headers
      },
      signal: controller.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return json ? await r.json() : await r.text();
  } finally {
    clearTimeout(t);
  }
}

function normalOpenFacts(data, source) {
  if (!data || Number(data.status) !== 1 || !data.product) return null;
  const p = data.product;
  const title = clean(first(p.product_name_ru, p.product_name_en, p.product_name, p.generic_name_ru, p.generic_name));
  return {
    source,
    title,
    brand: clean(p.brands),
    category: clean(p.categories),
    image: first(p.image_front_url, p.image_url, p.image_front_small_url),
    quantity: clean(p.quantity),
    description: clean(first(p.generic_name_ru, p.generic_name)),
    countries: clean(p.countries),
    manufacturing: clean(p.manufacturing_places),
    labels: clean(p.labels)
  };
}

async function queryOpenFacts(source, ean) {
  try {
    const fields = [
      'code','product_name','product_name_ru','product_name_en','generic_name','generic_name_ru',
      'brands','categories','quantity','image_front_url','image_front_small_url','image_url',
      'labels','countries','manufacturing_places'
    ].join(',');
    const data = await get(source.base + '/api/v2/product/' + encodeURIComponent(ean) + '.json?fields=' + fields, {json:true});
    const item = normalOpenFacts(data, source);
    return { name: source.name, ok: !!item, item };
  } catch (e) {
    return { name: source.name, ok: false, item: null };
  }
}

async function queryUPC(ean) {
  try {
    const data = await get('https://api.upcitemdb.com/prod/trial/lookup?upc=' + encodeURIComponent(ean), {json:true});
    const x = Array.isArray(data?.items) ? data.items[0] : null;
    if (!x) return { name:'UPCitemdb', ok:false, item:null };
    return {
      name:'UPCitemdb',
      ok:true,
      item:{
        source:{key:'upc',name:'UPCitemdb'},
        title:clean(x.title),
        brand:clean(x.brand),
        category:clean(x.category),
        image:Array.isArray(x.images) ? x.images[0] : '',
        quantity:'',
        description:clean(x.description),
        model:clean(x.model),
        dimension:clean(x.dimension),
        weight:clean(x.weight)
      }
    };
  } catch (e) {
    return { name:'UPCitemdb', ok:false, item:null };
  }
}

function decodeXml(s='') {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)));
}

function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>','i'));
  return m ? decodeXml(m[1]).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim() : '';
}

function parseBing(xml, ean) {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  const seen = new Set();
  return blocks.map(b => {
    const title = tag(b,'title');
    const url = tag(b,'link');
    const snippet = tag(b,'description');
    let domain = '';
    try { domain = new URL(url).hostname.replace(/^www\./,''); } catch {}
    return { title, url, snippet, domain, exact:(title + ' ' + snippet).includes(ean) };
  }).filter(x => {
    if (!x.title || !/^https?:\/\//i.test(x.url) || seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  }).slice(0,10);
}

async function webSearch(ean) {
  const queries = [
    '"' + ean + '"',
    ean + ' EAN'
  ];
  for (const q of queries) {
    try {
      const url = 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&format=rss';
      const xml = await get(url);
      const rows = parseBing(xml, ean);
      if (rows.length) return rows;
    } catch {}
  }
  return [];
}

function choose(items, field) {
  for (const x of items) {
    const v = x?.[field];
    if (v !== undefined && v !== null && clean(v) !== '') return v;
  }
  return '';
}

function cleanWebTitle(title='') {
  return clean(title)
    .replace(/\s+[\-|–|—|:]\s+[^\-|–|—]{1,60}$/,'')
    .replace(/^\d{8,14}\s*[\-|–|—|:]?\s*/,'')
    .trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','s-maxage=1800, stale-while-revalidate=86400');

  if (req.method !== 'GET') return res.status(405).json({ok:false,error:'METHOD_NOT_ALLOWED'});

  const ean = normalize(req.query?.ean || '');
  if (!validGTIN(ean)) return res.status(400).json({ok:false,error:'INVALID_EAN'});

  const settled = await Promise.all([
    ...SOURCES.map(s => queryOpenFacts(s, ean)),
    queryUPC(ean),
    webSearch(ean)
  ]);

  const web = settled.pop() || [];
  const sourceRows = settled;
  const items = sourceRows.filter(x => x.item).map(x => x.item);

  const bestWeb = web.find(x => x.exact) || web[0] || null;
  const title = choose(items,'title') || cleanWebTitle(bestWeb?.title || '') || ('Товар ' + ean);

  const product = (items.length || web.length) ? {
    ean,
    title,
    brand: choose(items,'brand') || '',
    category: choose(items,'category') || '',
    image: choose(items,'image') || '',
    quantity: choose(items,'quantity') || '',
    description: choose(items,'description') || bestWeb?.snippet || '',
    countries: choose(items,'countries') || '',
    manufacturing: choose(items,'manufacturing') || '',
    model: choose(items,'model') || '',
    dimension: choose(items,'dimension') || '',
    weight: choose(items,'weight') || '',
    sourceCount: items.length,
    webCount: web.length
  } : null;

  return res.status(200).json({
    ok:true,
    product,
    sources:sourceRows.map(x => ({name:x.name, ok:x.ok})),
    webResults:web,
    marketplaceLinks:{
      ozon:'https://www.ozon.ru/search/?text=' + encodeURIComponent(ean),
      wildberries:'https://www.wildberries.ru/catalog/0/search.aspx?search=' + encodeURIComponent(ean),
      yandex:'https://market.yandex.ru/search?text=' + encodeURIComponent(ean),
      vek21:'https://www.21vek.by/search/?term=' + encodeURIComponent(ean)
    }
  });
}
