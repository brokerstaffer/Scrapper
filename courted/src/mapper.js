// mapper.js — turn a raw Courted API record into a flat output row using the
// OUTPUT_COLUMNS schema. Used for both the search-list record and (when
// enrichment is on) the richer detail record, which is merged on top.

import {
    createEmptyAgent, int, dec, pct, str, yesno, monthsToYears, PROFILE_URL_BASE,
} from './constants.js';

/** Map a search-list record to a full output row. */
export function mapSearchRecord(r, searchedLocation = '') {
    const a = createEmptyAgent();

    // Identity & contact
    a['Name'] = str(r.full_name);
    a['First Name'] = str(r.first_name);
    a['Last Name'] = str(r.last_name);
    a['Email'] = str(r.email);
    a['Phone'] = str(r.phone);
    a['Saved Contact Info'] = formatContactInfo(r.broker_agent_contact_info);
    a['Profile Photo URL'] = str(r.agent_photo);
    a['Courted Agent ID'] = str(r.courted_mls_id);
    a['Courted ID'] = str(r.courted_id);
    a['Member MLS ID'] = str(r.member_mls_id);
    a['Courted Profile URL'] = r.courted_mls_id ? PROFILE_URL_BASE + r.courted_mls_id : '';

    // Office / brokerage
    a['Office'] = str(r.current_office_name);
    a['Custom Office Name'] = str(r.custom_office_name);
    a['Brand'] = str(r.brand_name);
    a['Office City'] = str(r.current_office_city);
    a['Office State'] = str(r.current_office_state);
    a['Office Zip'] = str(r.current_office_postal_code);
    a['Time At Current Office (mos)'] = dec(r.time_at_current_office, 1);
    a['Avg Time At Office (mos)'] = dec(r.avg_time_at_office, 1);

    // Experience
    a['Years Of Experience'] = monthsToYears(r.agent_tenure);
    a['Agent Tenure (mos)'] = dec(r.agent_tenure, 1);
    a['Is New Agent'] = yesno(r.is_new_agent);

    // Sales & activity (LTM)
    a['LTM Sales Volume'] = int(r.ltm_sales_volume);
    a['Prev LTM Sales Volume'] = int(r.prev_ltm_sales_volume);
    a['Sales Volume Change %'] = pct(r.ltm_sales_volume_change);
    a['LTM Est GCI'] = int(r.ltm_est_gci);
    a['LTM Avg Sale Price'] = int(r.ltm_avg_sale_price);
    a['LTM Closed Transactions'] = int(r.ltm_closed_transactions);
    a['LTM Closed Units'] = int(r.ltm_closed_units);
    a['LTM Units Buy-Side'] = int(r.ltm_closed_units_buy_side);
    a['LTM Units List-Side'] = int(r.ltm_closed_units_list_side);
    a['LTM Sales Volume Buy-Side'] = int(r.ltm_sales_volume_buy);
    a['LTM Sales Volume List-Side'] = int(r.ltm_sales_volume_list);
    a['LTM Avg Sale Price Buy-Side'] = int(r.ltm_avg_sale_price_buy);
    a['LTM Avg Sale Price List-Side'] = int(r.ltm_avg_sale_price_list);
    a['LTM Close-To-List Price %'] = r.ltm_close_to_list_price != null ? pct(Number(r.ltm_close_to_list_price) * 100) : '';
    a['LTM Avg Days On Market'] = int(r.ltm_average_days_on_market);
    a['LTM Rental Count'] = int(r.ltm_rental_count);
    a['LTM Avg Rental Price'] = int(r.ltm_avg_rental_price);

    // YTD
    a['YTD Sales Volume'] = int(r.ytd_sales_volume);
    a['YTD Units'] = int(r.ytd_units);
    a['YTD Avg Sale Price'] = int(r.ytd_average_sales_price);

    // Listings
    a['Active Listings'] = int(r.active_listings);
    a['Pending Listings'] = int(r.pending_listings);

    // Predictions / signals
    a['Sales Volume Prediction'] = int(r.sales_volume_prediction);
    a['Prediction Low'] = int(r.sales_volume_prediction_low);
    a['Prediction High'] = int(r.sales_volume_prediction_high);
    a['Likelihood To Move'] = str(r.likelihood_to_move_tag);
    a['Future Growth Tag'] = str(r.future_growth_perc_tag);

    // Most transacted
    a['Most Transacted City'] = str(r.most_transacted_city);
    a['Most Transacted State'] = str(r.most_transacted_state);
    a['Most Transacted Zip'] = str(r.most_transacted_zip);

    // MLS / licensing
    a['MLS'] = str(r.mls_short_name);
    a['MLS ID'] = str(r.mls_id);
    a['State License'] = str(r.state_license);
    a['Alt State Licenses'] = Array.isArray(r.alt_state_licenses) ? r.alt_state_licenses.join('; ') : str(r.alt_state_licenses);

    // Home / personal
    a['Home Address'] = str(r.home_address);
    a['Home City'] = str(r.home_address_city);
    a['Home State'] = str(r.home_address_state);
    a['Home Zip'] = str(r.home_address_postal_code);

    // CRM / pipeline
    a['Prospect Status'] = str(r.broker_company_prospect_status);
    a['Assigned To'] = str(r.broker_company_prospect_assigned_to_full_name);
    a['Connections'] = int(r.connections);
    a['Is Watching'] = yesno(r.is_watching);
    a['Is Liked'] = r.is_liked ? 'Yes' : (r.is_liked === 0 ? 'No' : '');

    a['Title'] = 'Salesperson';    // default; mergeDetail() upgrades it when the role is known
    a['Searched Location'] = searchedLocation;
    return a;
}

// Role title from the boolean flags, contains-searchable (both → comma-joined).
// Someone with neither role is a plain Salesperson. Mirrors the engine's
// post-sweep title stamp (web/server/engines/courted.js) so enrichment and the
// filter pass agree.
function roleTitle(a) {
    const parts = [];
    if (a['Is Managing Broker'] === 'Yes') parts.push('Managing Broker');
    if (a['Is Team Leader'] === 'Yes') parts.push('Team Leader');
    return parts.length ? parts.join(', ') : 'Salesperson';
}

/** Merge the richer detail record on top of an existing row (fills extras). */
export function mergeDetail(a, d) {
    if (!d) return a;
    if (!a['Nickname']) a['Nickname'] = str(d.nickname);
    if (!a['Mobile Phone']) a['Mobile Phone'] = str(d.mobile_phone);
    if (!a['Phone']) a['Phone'] = str(d.phone);
    if (!a['Email']) a['Email'] = str(d.email);
    if (!a['Office Address']) a['Office Address'] = str(d.current_office_address);
    a['MLS Affiliations'] = formatAffiliations(d.mls_affiliations) || a['MLS Affiliations'];
    a['Forecast Segment'] = str(d.forecast_segment) || a['Forecast Segment'];
    a['AI Agent Type'] = str(d.ai_agent_type) || a['AI Agent Type'];
    a['Is Team Leader'] = yesno(d.at_team_leader) || a['Is Team Leader'];
    a['Is Team Member'] = yesno(d.at_team_member) || a['Is Team Member'];
    a['Is Managing Broker'] = yesno(d.at_manager_managing_broker) || a['Is Managing Broker'];
    a['Is Rental Agent'] = yesno(d.at_rental_agent) || a['Is Rental Agent'];
    if (!a['Profile Photo URL']) a['Profile Photo URL'] = str(d.agent_photo);
    a['Title'] = roleTitle(a); // now that role flags are known, set the real title
    return a;
}

function formatContactInfo(ci) {
    if (!ci || typeof ci !== 'object') return '';
    const parts = [];
    for (const key of ['email', 'phone', 'mobile_phone', 'personal_email']) {
        if (ci[key]) parts.push(`${key}: ${ci[key]}`);
    }
    return parts.join('; ');
}

function formatAffiliations(aff) {
    if (!Array.isArray(aff)) return '';
    return aff
        .map((x) => (typeof x === 'object' && x ? (x.name || x.mls_short_name || x.mls_id || JSON.stringify(x)) : x))
        .filter(Boolean)
        .join('; ');
}
