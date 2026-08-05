"use strict";
// DB-row -> API-shape mapper functions, extracted from server.js (were previously the "Map
// functions" section). All pure (read only their own row argument) except mapShipment, which
// needs portLanesMap to resolve tradeLane, and mapContainer, which needs CUTOFF_WARNING_DAYS via
// cutoffState — both threaded in via this factory rather than importing server.js's own module
// scope, matching the createAisListener({ db, ... }) factory pattern already used in this codebase.

function createMappers({ portLanesMap, CUTOFF_WARNING_DAYS }) {
  const SVC_ABBR = { 'Port-to-Port': 'P2P', 'Door-to-Port': 'D2P', 'Port-to-Door': 'P2D', 'Door-to-Door': 'D2D' };

  function longestLane(un) {
    const s = portLanesMap[un]; if (!s || !s.size) return ''; return [...s].sort((a, b) => b.length - a.length)[0];
  }

  const mapShipment     = r => { const polLane = longestLane(r.pol), podLane = longestLane(r.pod); return { id: r.id, pol: r.pol, polName: r.pol_name || '', pod: r.pod, podName: r.pod_name || '', carrierCode: r.carrier_code, contractType: r.contract_type, contractNotes: r.contract_notes || '', status: r.status, createdAt: r.created_at, etd: r.etd || '', eta: r.eta || '', bookingRef: r.booking_ref || '', blNumber: r.bl_number || '', vessel: r.vessel || '', voyage: r.voyage || '', incoterm: r.incoterm || '', vesselImo: r.vessel_imo || '', contractId: r.contract_id || '', contractRef: r.contract_ref || '', commodityCode: r.commodity_code || '', shipperId: r.shipper_id || '', shipperName: r.shipper_name || '', consigneeId: r.consignee_id || '', consigneeName: r.consignee_name || '', principalId: r.principal_id || '', principalName: r.principal_name || '', allocationId: r.allocation_id || '', spaceSkipReason: r.space_skip_reason || '', spaceOverageReason: r.space_overage_reason || '', spaceBadge: r.space_badge || '', marginBuyUsd: r.margin_buy_usd ?? null, marginSellUsd: r.margin_sell_usd ?? null, overdueCount: r.overdue_count ?? 0, bookingStatus: r.booking_status || null, bookingRequestedAt: r.booking_requested_at || null, freightTerms: r.freight_terms || 'Prepaid', movementType: r.movement_type || 'FCL', serviceType: r.service_type || 'Port-to-Port', placeOfReceipt: r.place_of_receipt || '', placeOfDelivery: r.place_of_delivery || '', cargoReadyDate: r.cargo_ready_date || null, notifyId: r.notify_id || '', notifyName: r.notify_name || '', declaredValue: r.declared_value ?? null, declaredValueCurrency: r.declared_value_currency || 'USD', routingTerm: r.routing_term || (SVC_ABBR[r.service_type] || 'P2P'), tradeLane: polLane && podLane ? polLane + ' → ' + podLane : '', emoOfficeId: r.emo_office_id || null, emoOfficeCode: r.emo_office_code || '', emoOfficeName: r.emo_office_name || '', imoOfficeId: r.imo_office_id || null, imoOfficeCode: r.imo_office_code || '', imoOfficeName: r.imo_office_name || '', controllingOfficeId: r.controlling_office_id || null, controllingOfficeCode: r.controlling_office_code || '', controllingOfficeName: r.controlling_office_name || '', contractValidFrom: r.contract_valid_from || '', contractValidTo: r.contract_valid_to || '' }; };
  const mapShipmentLeg = r => ({
    id: r.id, shipmentId: r.shipment_id, legOrder: r.leg_order,
    mot: r.mot || 'SEA',
    legType:      r.leg_type      || r.mot || 'SEA',
    movementType: r.movement_type || r.mot || 'SEA',
    pol: r.pol || '', pod: r.pod || '',
    polLocType: r.pol_loc_type || 'Terminal', podLocType: r.pod_loc_type || 'Terminal',
    polLatitude: r.pol_latitude ?? null, polLongitude: r.pol_longitude ?? null,
    podLatitude: r.pod_latitude ?? null, podLongitude: r.pod_longitude ?? null,
    etd: r.etd || null, eta: r.eta || null,
    etdSource: r.etd_source || '', etaSource: r.eta_source || '',
    carrierCode: r.carrier_code || '', vessel: r.vessel || '', vesselImo: r.vessel_imo || '',
    voyage: r.voyage || '', movementBy: r.movement_by || '',
    contractType: r.contract_type || '', contractRef: r.contract_ref || '',
    createdAt: r.created_at,
  });

  const mapCostLine     = r => {
    const amountUsd = Math.round(r.amount * r.exchange_rate * 100) / 100;
    const actualAmountUsd = r.actual_amount != null
      ? Math.round(r.actual_amount * (r.actual_exchange_rate ?? r.exchange_rate) * 100) / 100
      : null;
    return {
      id: r.id, shipmentId: r.shipment_id, type: r.type, chargeCode: r.charge_code, currency: r.currency,
      amount: r.amount, exchangeRate: r.exchange_rate, amountUsd,
      vatRate: r.vat_rate || 0, vatAmountUsd: Math.round(r.amount * r.exchange_rate * (r.vat_rate || 0) / 100 * 100) / 100,
      notes: r.notes || '', containerId: r.container_id || '', source: r.source || 'manual',
      paymentIndicator: r.payment_indicator || 'Prepaid',
      modifiedAt: r.modified_at || null, createdAt: r.created_at, rateSnapshotId: r.rate_snapshot_id || '',
      status: r.status || 'accrued',
      actualAmount: r.actual_amount, actualExchangeRate: r.actual_exchange_rate, actualAmountUsd,
      actualizedAt: r.actualized_at || null, actualizedBy: r.actualized_by || '',
      postedAt: r.posted_at || null, postedBy: r.posted_by || '',
      varianceUsd: actualAmountUsd != null ? Math.round((actualAmountUsd - amountUsd) * 100) / 100 : null,
    };
  };
  const mapService      = r => ({ id: r.id, shipmentId: r.shipment_id, side: r.side, serviceType: r.service_type, status: r.status, vendorId: r.vendor_id || '', vendorName: r.vendor_name || '', officeId: r.office_id || '', officeCode: r.office_code || '', officeName: r.office_name || '', requestedDate: r.requested_date || '', confirmedDate: r.confirmed_date || '', completedDate: r.completed_date || '', notes: r.notes || '', createdAt: r.created_at, createdBy: r.created_by || '' });
  const mapRateSnapshot     = r => ({ id: r.id, shipmentId: r.shipment_id, contractId: r.contract_id, generatedAt: r.generated_at, generatedBy: r.generated_by || '', reason: r.reason });
  const mapRateSnapshotLine = r => ({ id: r.id, snapshotId: r.snapshot_id, serviceCode: r.service_code || '', description: r.description || '', amount: r.amount, currency: r.currency, amountUsd: r.amount_usd, unit: r.unit || 'per_container', containerType: r.container_type || '', notes: r.notes || '' });
  const mapChargeCodeDefinition = r => ({ id: r.id, code: r.code, label: r.label, trigger: r.trigger, amount: r.amount, currency: r.currency, unit: r.unit, isActive: r.is_active === 1, createdAt: r.created_at });
  // Fixed-deadline compliance badge (VGM/CY cutoff): 'none' when unset, 'closed-ok'
  // once resolved (e.g. VGM Submitted) regardless of date, else 'ok'/'amber'/'red'
  // against CUTOFF_WARNING_DAYS. Pure function of the date + today — no DB join needed,
  // so it's cheap enough to run inline in mapContainer on every read.
  const cutoffState = (dateStr, resolved) => {
    if (resolved) return 'closed-ok';
    if (!dateStr) return 'none';
    const parsed = new Date(dateStr);
    if (isNaN(parsed)) return 'none';
    const days = Math.round((parsed - new Date(new Date().toISOString().slice(0, 10))) / 86400000);
    return days < 0 ? 'red' : days <= CUTOFF_WARNING_DAYS ? 'amber' : 'ok';
  };
  const mapContainer    = r => ({ id: r.id, shipmentId: r.shipment_id, containerNumber: r.container_number || '', sealNumber: r.seal_number || '', size: r.size, type: r.type, hsCode: r.hs_code || '', cargoDescription: r.cargo_description || '', marksAndNumbers: r.marks_and_numbers || '', grossWeightKg: r.gross_weight_kg ?? null, volumeCbm: r.volume_cbm ?? null, isDg: r.is_dg === 1, dgClass: r.dg_class || '',
    vgmWeightKg: r.vgm_weight_kg ?? null, vgmStatus: r.vgm_status || 'Pending', vgmCutoff: r.vgm_cutoff || '',
    vgmCutoffState: cutoffState(r.vgm_cutoff, (r.vgm_status || 'Pending') === 'Submitted'),
    cyCutoff: r.cy_cutoff || '', cyCutoffState: cutoffState(r.cy_cutoff, false),
    originFreeTimeDays: r.origin_free_time_days ?? null, destFreeTimeDays: r.dest_free_time_days ?? null });
  const mapContainerEvent = r => ({ id: r.id, containerId: r.container_id, shipmentId: r.shipment_id, eventType: r.event_type, location: r.location || '', occurredAt: r.occurred_at, recordedBy: r.recorded_by || '', notes: r.notes || '', createdAt: r.created_at });
  const mapContainerPackage = r => ({ id: r.id, containerId: r.container_id, parentId: r.parent_id || null, description: r.description, quantity: r.quantity, position: r.position, packTypeId: r.pack_type_id || null, isDg: r.is_dg === 1, dgClass: r.dg_class || '', unitValue: r.unit_value ?? null, currency: r.currency || '', hsCode: r.hs_code || '', unitValueUsd: r.unit_value_usd ?? null, createdAt: r.created_at });
  const mapShipmentParty = r => ({ id: r.id, shipmentId: r.shipment_id, role: r.role, customerId: r.customer_id, customerName: r.customer_name, createdAt: r.created_at });
  const mapPackTypeDefinition = r => ({ id: r.id, code: r.code, label: r.label, icon: r.icon, sortOrder: r.sort_order, isActive: r.is_active === 1, createdAt: r.created_at });
  const mapAllocation   = r => ({ id: r.id, carrierCode: r.carrier_code, allocatedTEU: r.allocated_teu, effectiveDate: r.effective_date || '', endDate: r.end_date || '', tradeLane: r.trade_lane || '', notes: r.notes || '', alertThreshold: r.alert_threshold ?? 80, pol: r.pol || '', pod: r.pod || '', originLane: r.origin_lane || '', destLane: r.dest_lane || '', coverageScope: r.coverage_scope || 'STRICT', contractId: r.contract_id || '', contractNumber: r.contract_number || '' });
  const mapCarrier      = r => ({ code: r.code, name: r.name, shortName: r.short_name || '' });
  const mapVessel       = r => ({ imo: r.imo, name: r.name, assetType: r.asset_type || '', flagIso2: r.flag_iso2 || '', flagName: r.flag_name || '', buildYear: r.build_year, grossTonnage: r.gross_tonnage, mmsi: r.mmsi || '', aisVerifiedAt: r.ais_verified_at || '' });
  const mapPortLocation = r => ({ unlocode: r.unlocode, name: r.name, latitude: r.latitude, longitude: r.longitude, countryCode: r.country_code, zoneCode: r.zone_code, timezone: r.timezone || null, lastSyncedAt: r.last_synced_at || null });
  const mapLinkedPort   = r => ({ id: r.id, primaryUnlocode: r.primary_unlocode, primaryName: r.primary_name || '', linkedUnlocode: r.linked_unlocode, linkedName: r.linked_name || '', note: r.note || '' });
  const mapCarrierAgent = r => ({ id: r.id, carrierCode: r.carrier_code, portUnlocode: r.port_unlocode, portName: r.port_name || '', agentCustomerId: r.agent_customer_id, agentCustomerName: r.agent_customer_name || '', note: r.note || '', createdAt: r.created_at });
  const mapTradeLane    = r => ({ code: r.code, name: r.name, description: r.description || '', countryCount: r.country_count ?? 0, transitDays: r.transit_days ?? 0 });
  const mapScopeItem    = r => ({
    id:        r.id,
    userId:    r.user_id,
    role:      r.role     || '',
    itemType:  r.item_type,
    value:     r.value,
    label:     r.label    || '',
    createdAt: r.created_at,
  });
  const mapAccessConfig = r => ({
    id:           r.id,
    userId:       r.user_id,
    label:        r.label || '',
    originLane:   r.origin_lane  || null,
    destLane:     r.dest_lane    || null,
    polCodes:     r.pol_codes      ? JSON.parse(r.pol_codes)      : [],
    podCodes:     r.pod_codes      ? JSON.parse(r.pod_codes)      : [],
    carrierCodes: r.carrier_codes  ? JSON.parse(r.carrier_codes)  : [],
    createdAt:    r.created_at,
  });
  const mapOffice       = r => ({ id: r.id, code: r.code, countryCode: r.country_code, unlocode: r.unlocode, department: r.department, name: r.name, isActive: !!r.is_active, branchId: r.branch_id || null, createdAt: r.created_at });
  // smtp_password is deliberately never included here — hasPassword (a boolean, not the secret
  // itself) is the only signal a client ever gets that a password is configured.
  const mapOfficeMailSettings = r => ({ id: r.id, officeId: r.office_id, smtpHost: r.smtp_host, smtpPort: r.smtp_port,
    secureMode: r.secure_mode, smtpUsername: r.smtp_username, hasPassword: !!r.smtp_password,
    fromAddress: r.from_address, fromName: r.from_name, isActive: !!r.is_active,
    createdAt: r.created_at, updatedAt: r.updated_at });
  const mapBranch       = r => ({ id: r.id, code: r.code, name: r.name, countryCode: r.country_code, locode: r.locode || null, city: r.city || null, address: r.address || null, timezone: r.timezone || null, phone: r.phone || null, email: r.email || null, isActive: !!r.is_active, createdAt: r.created_at });
  const mapOrgCountry   = r => ({ countryCode: r.country_code, countryName: r.country_name || null, defaultCurrency: r.default_currency || null, timezone: r.timezone || null, branchId: r.branch_id || null, branchCode: r.branch_code || null, branchName: r.branch_name || null, complianceNotes: r.compliance_notes || null, isActive: !!r.is_active, addedAt: r.added_at });
  const mapRegion       = r => ({ code: r.code, name: r.name, description: r.description || '' });
  const mapCountry      = r => ({ iso2: r.iso2, name: r.name, unMember: r.un_member === 1, regionCode: r.region_code || '', portCount: r.port_count ?? 0 });
  const mapTicketLink   = r => ({ id: r.id, fromId: r.from_id, toId: r.to_id, linkType: r.link_type, createdAt: r.created_at });
  const mapTicket       = r => ({
    id:              r.id,
    title:           r.title,
    section:         r.section         || '',
    description:     r.description     || '',
    priority:        r.priority        || 'Medium',
    status:          r.status          || 'Ready',
    position:        r.position        ?? 0,
    createdAt:       r.created_at,
    shipmentId:      r.shipment_id     || null,
    type:            r.type            || 'Task',
    version:         r.version         || '',
    // v0.20.0 — nesting + assignee + due date
    parentId:        r.parent_id       || null,
    assigneeId:      r.assignee_id     || null,
    assigneeName:    r.assignee_name   || null,   // joined from users at query time
    assigneeInitial: r.assignee_name   ? r.assignee_name.trim()[0].toUpperCase() : null,
    dueDate:         r.due_date        || null,
    testNotes:       r.test_notes      || null,
    projectId:       r.project_id      || null,
    versionId:       r.version_id      || null,
  });
  const mapTestItem     = r => ({
    id:              r.id,
    type:            r.type,
    title:           r.title,
    description:     r.description     || '',
    priority:        r.priority        || 'Medium',
    status:          r.status          || 'Ready',
    position:        r.position        ?? 0,
    createdAt:       r.created_at,
    shipmentId:      r.shipment_id     || null,
    parentId:        r.parent_id       || null,
    assigneeId:      r.assignee_id     || null,
    assigneeName:    r.assignee_name   || null,
    assigneeInitial: r.assignee_name   ? r.assignee_name.trim()[0].toUpperCase() : null,
    dueDate:         r.due_date        || null,
    testNotes:       r.test_notes      || null,
    projectId:       r.project_id      || null,
    versionId:       r.version_id      || null,
  });
  const mapTestCaseLink = r => ({ id: r.id, caseId: r.case_id, ticketId: r.ticket_id, createdAt: r.created_at });
  const mapEdiMessage = r => ({
    id:            r.id,
    shipmentId:    r.shipment_id,
    carrierCode:   r.carrier_code,
    direction:     r.direction,
    messageType:   r.message_type,
    format:        r.format || 'JSON',
    rawPayload:    r.raw_payload    || '',
    parsedPayload: r.parsed_payload || '',
    status:        r.status || 'pending',
    correlationId: r.correlation_id || '',
    isMock:        !!r.is_mock,
    createdAt:     r.created_at,
    processedAt:   r.processed_at || null,
  });
  const mapCarrierBooking = r => ({
    id:                 r.id,
    shipmentId:         r.shipment_id,
    carrierCode:        r.carrier_code || '',
    status:             r.status || 'Pending',
    lastResponseStatus: r.last_response_status || '',
    bookingRef:         r.booking_ref || '',
    correlationId:      r.correlation_id || '',
    isMock:             !!r.is_mock,
    requestedAt:        r.requested_at || null,
    requestedBy:        r.requested_by || '',
    respondedAt:        r.responded_at || null,
    confirmedAt:        r.confirmed_at || null,
    confirmedBy:        r.confirmed_by || '',
    cancelledAt:        r.cancelled_at || null,
    cancelledBy:        r.cancelled_by || '',
    cancelReason:       r.cancel_reason || '',
    createdAt:          r.created_at,
    updatedAt:          r.updated_at,
    archivedAt:         r.archived_at || null,
    archivedReason:     r.archived_reason || '',
    blDocumentId:       r.bl_document_id || null,
  });
  const mapCustomsFiling = r => ({
    id:                 r.id,
    shipmentId:         r.shipment_id,
    filingType:         r.filing_type,
    status:             r.status || 'Draft',
    filingReference:    r.filing_reference || '',
    confirmationNumber: r.confirmation_number || '',
    rejectionReason:    r.rejection_reason || '',
    filedAt:            r.filed_at || null,
    filedBy:            r.filed_by || '',
    respondedAt:        r.responded_at || null,
    createdAt:          r.created_at,
    updatedAt:          r.updated_at,
  });
  const mapKbProject = r => ({ id: r.id, name: r.name, key: r.key, color: r.color || '#6366f1', description: r.description || '', createdAt: r.created_at });
  const mapKbVersion = r => ({ id: r.id, projectId: r.project_id, name: r.name, description: r.description || '', status: r.status || 'Planning', releaseDate: r.release_date || null, createdAt: r.created_at });
  const mapKbColumn  = r => ({ id: r.id, projectId: r.project_id, name: r.name, position: r.position ?? 0, color: r.color || '#6366f1', wipLimit: r.wip_limit ?? null, createdAt: r.created_at });
  const mapCustomer            = r => ({ id: r.id, companyName: r.company_name, address1: r.address1 || '', address2: r.address2 || '', city: r.city || '', state: r.state || '', postalCode: r.postal_code || '', countryIso2: r.country_iso2 || '', phone: r.phone || '', fax: r.fax || '', email: r.email || '', website: r.website || '', notes: r.notes || '', createdAt: r.created_at, screeningResult: r.screening_result || null, currency: r.currency || 'USD', creditLimit: r.credit_limit ?? null, creditTermsDays: r.credit_terms_days ?? null, creditHold: !!r.credit_hold, creditHoldReason: r.credit_hold_reason || '', parentCustomerId: r.parent_customer_id || null, parentCustomerName: r.parent_customer_name || null, classifiedLocation: !!r.classified_location, latitude: r.latitude ?? null, longitude: r.longitude ?? null });
  const mapCustomerIdentifier  = r => ({ id: r.id, customerId: r.customer_id, idType: r.id_type, idCode: r.id_code, countryIso2: r.country_iso2 || '', label: r.label || '', isPrimary: !!r.is_primary, createdAt: r.created_at });
  const mapCustomerScreening   = r => ({ id: r.id, customerId: r.customer_id, screenedAt: r.screened_at, result: r.result, hits: JSON.parse(r.hits || '[]'), overriddenAt: r.overridden_at || null, overrideReason: r.override_reason || null });
  const mapCustomerDoc         = r => ({ id: r.id, customerId: r.customer_id, filename: r.filename, mimeType: r.mime_type, sizeBytes: r.size_bytes, docType: r.doc_type, uploadedBy: r.uploaded_by, createdAt: r.created_at });
  const mapCustomerContact     = r => ({ id: r.id, customerId: r.customer_id, name: r.name, title: r.title || '', email: r.email || '', phone: r.phone || '', department: r.department || 'Other', isPrimary: !!r.is_primary, createdAt: r.created_at });
  const mapCommodity    = r => ({ code: r.code, description: r.description, gradeCode: r.grade_code, gradeName: r.grade_name });
  const mapSystemMessage = r => ({
    id: r.id, title: r.title, body: r.body,
    severity: r.severity, activeFrom: r.active_from, activeTo: r.active_to, createdAt: r.created_at,
  });
  const mapMilestone         = r => ({ id: r.id, shipmentId: r.shipment_id, milestoneKey: r.milestone_key, label: r.label, sequenceOrder: r.sequence_order, estimatedDate: r.estimated_date || '', completedAt: r.completed_at || '', completedBy: r.completed_by || '', note: r.note || '', createdAt: r.created_at });
  const mapMilestoneTemplate = r => ({ id: r.id, templateKey: r.template_key, carrierCode: r.carrier_code || '', tradeLane: r.trade_lane || '', milestoneKey: r.milestone_key, label: r.label, sequenceOrder: r.sequence_order, createdAt: r.created_at });

  const mapContract = r => ({
    id:              r.id,
    contractNumber:  r.contract_number,
    contractRef:     r.contract_ref     || '',
    carrierCode:     r.carrier_code,
    namedAccountId:  r.named_account_id,
    namedAccount:    r.named_account,
    movementType:    r.movement_type,
    containerTypes:  JSON.parse(r.container_types  || "[]"),
    dgAllowed:       !!r.dg_allowed,
    imdgClasses:     JSON.parse(r.imdg_classes      || "[]"),
    validFrom:       r.valid_from,
    validTo:         r.valid_to,
    currency:        r.currency,
    status:          r.status,
    notes:           r.notes,
    createdAt:       r.created_at,
  });
  const mapLeg = r => ({
    id:            r.id,
    contractId:    r.contract_id,
    legOrder:      r.leg_order,
    pol:           r.pol,
    polName:       r.pol_name,
    pod:           r.pod,
    podName:       r.pod_name,
    transitDays:         r.transit_days,
    vesselService:       r.vessel_service,
    polLinkedAllowed:    r.pol_linked_allowed   === 1,
    podLinkedAllowed:    r.pod_linked_allowed   === 1,
    polCarrierHaulage:   r.pol_carrier_haulage  === 1,
    podCarrierHaulage:   r.pod_carrier_haulage  === 1,
    polHaulageLocations: r.pol_haulage_locations || '',
    podHaulageLocations: r.pod_haulage_locations || '',
    polLocType: r.pol_loc_type || (r.pol_carrier_haulage === 1 ? 'Door' : 'Terminal'),
    podLocType: r.pod_loc_type || (r.pod_carrier_haulage === 1 ? 'Door' : 'Terminal'),
  });
  const mapRate = r => ({
    id:            r.id,
    contractId:    r.contract_id,
    serviceCode:   r.service_code,
    description:   r.description,
    amount:        r.amount,
    currency:      r.currency,
    amountUsd:     r.amount_usd,
    unit:          r.unit,
    containerType: r.container_type,
    sortOrder:     r.sort_order,
    notes:         r.notes,
  });

  return {
    SVC_ABBR, longestLane, cutoffState,
    mapShipment, mapShipmentLeg, mapCostLine, mapService, mapRateSnapshot, mapRateSnapshotLine,
    mapChargeCodeDefinition, mapContainer, mapContainerEvent, mapContainerPackage, mapShipmentParty,
    mapPackTypeDefinition, mapAllocation, mapCarrier, mapVessel, mapPortLocation, mapLinkedPort,
    mapCarrierAgent, mapTradeLane, mapScopeItem, mapAccessConfig, mapOffice, mapOfficeMailSettings,
    mapBranch, mapOrgCountry, mapRegion, mapCountry, mapTicketLink, mapTicket, mapTestItem,
    mapTestCaseLink, mapEdiMessage, mapCarrierBooking, mapCustomsFiling, mapKbProject, mapKbVersion,
    mapKbColumn, mapCustomer, mapCustomerIdentifier, mapCustomerScreening, mapCustomerDoc,
    mapCustomerContact, mapCommodity, mapSystemMessage, mapMilestone, mapMilestoneTemplate,
    mapContract, mapLeg, mapRate,
  };
}

module.exports = { createMappers };
