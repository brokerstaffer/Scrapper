// realtor-map.js — output columns + mappers for realtor.com agents.
// Data comes from the page's __NEXT_DATA__ (server-rendered JSON), so this is
// clean structured mapping, not DOM scraping.

export const OUTPUT_COLUMNS = [
    'Name', 'First Name', 'Last Name', 'Phone', 'Mobile Phone', 'Email',
    'Office', 'Broker', 'Office Address', 'Office City', 'Office State', 'Office Postal',
    'Rating', 'Review Count', 'Recommendations',
    'Years Of Experience', 'Experience Since',
    'Languages', 'Specializations', 'Designations', 'Served Areas',
    'For Sale Count', 'For Sale Price Range',
    'Sold Count', 'Sold Price Range', 'Last Sold Date',
    'Combined Price Range',
    'License Number', 'License State', 'MLS',
    'Website URL', 'Facebook URL', 'Instagram URL', 'LinkedIn URL',
    'Twitter URL', 'YouTube URL', 'TikTok URL',
    'Profile Photo URL', 'Bio', 'Is Realtor', 'Is Advertiser',
    'Realtor Profile URL', 'Realtor Agent ID', 'Fulfillment ID', 'Searched Location',
];

export function emptyRecord() {
    const r = {};
    for (const c of OUTPUT_COLUMNS) r[c] = '';
    return r;
}

export function profileUrl(id) {
    return `https://www.realtor.com/realestateagents/${id}`;
}

/** Search-list agent → base record (the fields realtor returns without enrich). */
export function mapSearchRecord(a, searchedLocation = '') {
    const r = emptyRecord();
    const rr = a.ratings_reviews || {};
    r['Name'] = clean(a.fullname);
    r['Office'] = a.office && a.office.name ? a.office.name : '';
    r['Broker'] = a.broker && a.broker.name ? a.broker.name : '';
    r['Rating'] = num(rr.average_rating);
    r['Review Count'] = num(rr.reviews_count);
    r['Recommendations'] = num(rr.recommendations_count);
    r['Combined Price Range'] = range((a.listing_stats || {}).combined_annual);
    r['Profile Photo URL'] = a.avatar && a.avatar.url ? a.avatar.url : '';
    r['Is Realtor'] = yesno(a.is_realtor);
    r['Is Advertiser'] = yesno(a.is_paid);
    r['Realtor Agent ID'] = a.id || '';
    r['Fulfillment ID'] = a.fulfillment_id || '';
    r['Realtor Profile URL'] = a.id ? profileUrl(a.id) : '';
    r['Searched Location'] = searchedLocation;
    return r;
}

/** Merge full agent-detail fields into a record (in place). */
export function mergeDetail(r, ag) {
    if (!ag) return r;
    if (!r['Name']) r['Name'] = clean(ag.fullname);
    const [first, ...rest] = clean(ag.fullname).split(/\s+/);
    if (!r['First Name'] && first) r['First Name'] = first;
    if (!r['Last Name'] && rest.length) r['Last Name'] = rest.join(' ');

    const phones = ag.phones || [];
    const office = phones.find((p) => p.type === 'office') || phones[0];
    const mobile = phones.find((p) => p.type === 'mobile' || p.type === 'cell');
    if (office) r['Phone'] = office.value || '';
    if (mobile) r['Mobile Phone'] = mobile.value || '';

    if (!r['Office'] && ag.office) r['Office'] = ag.office.name || '';
    if (!r['Broker'] && ag.broker) r['Broker'] = ag.broker.name || '';
    const oa = (ag.office && ag.office.address) || {};
    r['Office Address'] = clean([oa.line, oa.line2].filter(Boolean).join(' '));
    r['Office City'] = clean(oa.city);
    r['Office State'] = clean(oa.state_code || oa.state);
    r['Office Postal'] = clean(oa.postal_code);

    const exp = ag.experience || {};
    r['Years Of Experience'] = clean(exp.label);
    r['Experience Since'] = clean(exp.first_year);
    r['Languages'] = names(ag.languages);
    r['Specializations'] = names(ag.specializations);
    r['Designations'] = names(ag.designations);
    r['Served Areas'] = names(ag.served_areas);

    const ls = ag.listing_stats || {};
    if (ls.for_sale) {
        r['For Sale Count'] = num(ls.for_sale.count);
        r['For Sale Price Range'] = range(ls.for_sale);
    }
    if (ls.recently_sold) {
        r['Sold Count'] = num(ls.recently_sold.count);
        r['Sold Price Range'] = range(ls.recently_sold);
        r['Last Sold Date'] = (ls.recently_sold.last_sold_date || '').slice(0, 10);
    }
    if (!r['Combined Price Range']) r['Combined Price Range'] = range(ls.combined_annual);

    r['License Number'] = clean(ag.license_number);
    r['License State'] = clean(ag.license_state);
    r['MLS'] = names(ag.mls, ['abbreviation', 'name', 'id']);

    if (ag.website) r['Website URL'] = ag.website.href || ag.website;
    const sm = ag.social_media || {};
    r['Facebook URL'] = href(sm.facebook);
    r['Instagram URL'] = href(sm.instagram);
    r['LinkedIn URL'] = href(sm.linkedin);
    r['Twitter URL'] = href(sm.x || sm.twitter);
    r['YouTube URL'] = href(sm.youtube);
    r['TikTok URL'] = href(sm.tiktok);

    if (!r['Rating'] && ag.ratings_reviews) r['Rating'] = num(ag.ratings_reviews.average_rating);
    if (!r['Review Count'] && ag.ratings_reviews) r['Review Count'] = num(ag.ratings_reviews.reviews_count);
    if (!r['Profile Photo URL'] && ag.avatar) r['Profile Photo URL'] = ag.avatar.url || '';
    r['Bio'] = clean(ag.bio && (ag.bio.value || ag.bio)).slice(0, 500);
    if (ag.is_realtor != null) r['Is Realtor'] = yesno(ag.is_realtor);
    if (ag.is_paid != null) r['Is Advertiser'] = yesno(ag.is_paid);
    return r;
}

// --- helpers ---
function clean(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }
function num(v) { return v == null || v === '' ? '' : String(v); }
function yesno(v) { return v ? 'Yes' : 'No'; }
function href(v) { if (!v) return ''; return typeof v === 'object' ? (v.href || '') : String(v); }
function names(arr, keys = ['name', 'value', 'abbreviation', 'id']) {
    if (!Array.isArray(arr)) return '';
    return arr.map((x) => {
        if (x && typeof x === 'object') { for (const k of keys) if (x[k]) return x[k]; return ''; }
        return x;
    }).filter(Boolean).join('; ');
}
function money(n) {
    if (n == null || n === '' || Number.isNaN(Number(n))) return '';
    n = Number(n);
    if (n >= 1e6) return `$${(n / 1e6).toFixed(n % 1e6 ? 1 : 0).replace(/\.0$/, '')}M`;
    if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
    return `$${n}`;
}
function range(o) {
    if (!o || (o.min == null && o.max == null)) return '';
    const lo = money(o.min); const hi = money(o.max);
    if (lo && hi) return `${lo} - ${hi}`;
    return lo || hi || '';
}
