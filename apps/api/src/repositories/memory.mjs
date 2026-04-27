import { HttpError } from "../http-error.mjs";

export function createMemoryRepositories(state) {
  function defaultEventPolicy(tenantId, eventId) {
    return {
      event_id: eventId,
      tenant_id: tenantId,
      vendor_exports_enabled: false,
      sponsor_pii_enabled: false,
      require_export_approval: true,
      allow_crm_push: false,
      retention_days: 30,
      allow_cross_event_identity_graph: false,
      created_at: null,
      updated_at: null,
      missing_policy_row: true
    };
  }

  function ensureTenant(record, tenantId, label) {
    if (!record) {
      throw new HttpError(404, `${label} not found`);
    }
    if ("tenant_id" in record && tenantId && record.tenant_id !== tenantId) {
      throw new HttpError(404, `${label} not found`);
    }
    return record;
  }

  function findById(list, tenantId, id, label) {
    return ensureTenant(list.find((entry) => entry.id === id), tenantId, label);
  }

  const repos = {
    backend: "memory",
    scope() {
      return repos;
    },
    async withTransaction(callback) {
      return callback(repos);
    },
    tenants: {
      async findById(tenantId) {
        return findById(state.tenants, null, tenantId, "Tenant");
      },
      async listAll() {
        return [...state.tenants];
      },
      async create(record) {
        state.tenants.push(record);
        return record;
      },
      async update(record) {
        const index = state.tenants.findIndex((t) => t.id === record.id);
        if (index === -1) throw new HttpError(404, "Tenant not found");
        state.tenants[index] = record;
        return record;
      },
      async findBySlug(slug) {
        return state.tenants.find((t) => t.slug === slug) ?? null;
      }
    },
    organizations: {
      async create(record) {
        state.organizations.push(record);
        return record;
      },
      async findById(tenantId, id) {
        return findById(state.organizations, tenantId, id, "Organization");
      },
      async listByTenant(tenantId) {
        return state.organizations.filter((entry) => entry.tenant_id === tenantId);
      },
      async update(record) {
        const index = state.organizations.findIndex((entry) => entry.id === record.id);
        if (index === -1) throw new HttpError(404, "Organization not found");
        state.organizations[index] = record;
        return record;
      }
    },
    users: {
      async create(record) {
        state.users.push(record);
        return record;
      },
      async findById(tenantId, id) {
        return findById(state.users, tenantId, id, "User");
      },
      async findByEmail(email) {
        return state.users.find((entry) => entry.email === email) ?? null;
      },
      async findByInviteTokenHash(hash) {
        return (
          state.users.find(
            (entry) => entry.invitation_token_hash === hash &&
              entry.invitation_expires_at &&
              new Date(entry.invitation_expires_at) > new Date()
          ) ?? null
        );
      },
      async findByResetTokenHash(hash) {
        return (
          state.users.find(
            (entry) => entry.password_reset_token_hash === hash &&
              entry.password_reset_expires_at &&
              new Date(entry.password_reset_expires_at) > new Date()
          ) ?? null
        );
      },
      async findByExternalSubject(issuer, subject) {
        return (
          state.users.find(
            (entry) =>
            entry.external_identity_provider === issuer && entry.external_subject === subject
          ) ?? null
        );
      },
      async listByTenant(tenantId) {
        return state.users.filter((entry) => entry.tenant_id === tenantId);
      },
      async update(record) {
        const index = state.users.findIndex((entry) => entry.id === record.id);
        if (index === -1) {
          throw new HttpError(404, "User not found");
        }
        state.users[index] = record;
        return record;
      }
    },
    events: {
      async create(record) {
        state.events.push(record);
        return record;
      },
      async findById(tenantId, id) {
        return findById(state.events, tenantId, id, "Event");
      },
      async listByTenant(tenantId) {
        return state.events.filter((entry) => entry.tenant_id === tenantId);
      },
      async listByIds(tenantId, ids) {
        const set = new Set(ids);
        return state.events.filter((entry) => entry.tenant_id === tenantId && set.has(entry.id));
      },
      async update(record) {
        const index = state.events.findIndex((entry) => entry.id === record.id);
        if (index === -1) throw new HttpError(404, "Event not found");
        state.events[index] = record;
        return record;
      }
    },
    halls: {
      async create(record) {
        state.halls.push(record);
        return record;
      },
      async findById(tenantId, id) {
        return findById(state.halls, tenantId, id, "Hall");
      },
      async listByEvent(tenantId, eventId) {
        return state.halls.filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId);
      },
      async update(record) {
        const index = state.halls.findIndex((entry) => entry.id === record.id);
        if (index === -1) throw new HttpError(404, "Hall not found");
        state.halls[index] = record;
        return record;
      },
      async deleteById(tenantId, id) {
        const index = state.halls.findIndex((entry) => entry.tenant_id === tenantId && entry.id === id);
        if (index === -1) throw new HttpError(404, "Hall not found");
        const [deleted] = state.halls.splice(index, 1);
        return deleted;
      }
    },
    stalls: {
      async create(record) {
        state.stalls.push(record);
        return record;
      },
      async findById(tenantId, id) {
        return findById(state.stalls, tenantId, id, "Stall");
      },
      async listByTenant(tenantId) {
        return state.stalls.filter((entry) => entry.tenant_id === tenantId);
      },
      async listByEvent(tenantId, eventId) {
        return state.stalls.filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId);
      },
      async update(record) {
        const index = state.stalls.findIndex((entry) => entry.id === record.id);
        if (index === -1) throw new HttpError(404, "Stall not found");
        state.stalls[index] = record;
        return record;
      },
      async deleteById(tenantId, id) {
        const index = state.stalls.findIndex((entry) => entry.tenant_id === tenantId && entry.id === id);
        if (index === -1) throw new HttpError(404, "Stall not found");
        const [deleted] = state.stalls.splice(index, 1);
        return deleted;
      }
    },
    sponsorPackages: {
      async create(record) {
        state.sponsorPackages.push(record);
        return record;
      },
      async findById(tenantId, id) {
        return findById(state.sponsorPackages, tenantId, id, "Sponsor package");
      },
      async listByEvent(tenantId, eventId) {
        return state.sponsorPackages.filter(
          (entry) => entry.tenant_id === tenantId && entry.event_id === eventId
        );
      },
      async update(record) {
        const index = state.sponsorPackages.findIndex((entry) => entry.id === record.id);
        if (index === -1) throw new HttpError(404, "Sponsor package not found");
        state.sponsorPackages[index] = record;
        return record;
      },
      async deleteById(tenantId, id) {
        const index = state.sponsorPackages.findIndex(
          (entry) => entry.tenant_id === tenantId && entry.id === id
        );
        if (index === -1) throw new HttpError(404, "Sponsor package not found");
        const [deleted] = state.sponsorPackages.splice(index, 1);
        return deleted;
      }
    },
    brandingAssets: {
      async findActiveByEvent(tenantId, eventId) {
        return (
          state.brandingAssets.find(
            (entry) => entry.tenant_id === tenantId && entry.event_id === eventId && entry.status === "active"
          ) ?? null
        );
      },
      async create(record) {
        state.brandingAssets.push(record);
        return record;
      },
      async update(record) {
        const index = state.brandingAssets.findIndex((entry) => entry.id === record.id);
        if (index === -1) throw new HttpError(404, "Branding asset not found");
        state.brandingAssets[index] = record;
        return record;
      }
    },
    eventPolicies: {
      async findByEventId(tenantId, eventId) {
        const existing = state.eventPolicies.find((entry) => entry.event_id === eventId);
        if (existing) {
          return ensureTenant(existing, tenantId, "Event policy");
        }
        const event = ensureTenant(state.events.find((entry) => entry.id === eventId), tenantId, "Event");
        return defaultEventPolicy(event.tenant_id, eventId);
      },
      async upsert(record) {
        const persisted = {
          ...record,
          missing_policy_row: false
        };
        const index = state.eventPolicies.findIndex(
          (entry) => entry.tenant_id === record.tenant_id && entry.event_id === record.event_id
        );
        if (index === -1) {
          state.eventPolicies.push(persisted);
          return persisted;
        }
        state.eventPolicies[index] = persisted;
        return persisted;
      }
    },
    devices: {
      async findById(tenantId, id) {
        return findById(state.devices, tenantId, id, "Device");
      },
      async listByTenant(tenantId) {
        return state.devices.filter((entry) => entry.tenant_id === tenantId);
      },
      async create(record) {
        state.devices.push(record);
        return record;
      },
      async update(record) {
        const index = state.devices.findIndex((entry) => entry.id === record.id);
        if (index === -1) throw new HttpError(404, "Device not found");
        state.devices[index] = record;
        return record;
      }
    },
    userAccessScopes: {
      async create(record) {
        state.userAccessScopes.push(record);
        return record;
      },
      async findById(tenantId, id) {
        return findById(state.userAccessScopes, tenantId, id, "User access scope");
      },
      async listByUser(tenantId, userId) {
        return state.userAccessScopes.filter(
          (entry) => entry.tenant_id === tenantId && entry.user_id === userId
        );
      },
      async deleteById(tenantId, id) {
        const index = state.userAccessScopes.findIndex(
          (entry) => entry.tenant_id === tenantId && entry.id === id
        );
        if (index === -1) {
          throw new HttpError(404, "User access scope not found");
        }
        const [deleted] = state.userAccessScopes.splice(index, 1);
        return deleted;
      }
    },
    userRoleAssignments: {
      async create(record) {
        state.userRoleAssignments.push(record);
        return record;
      },
      async findById(tenantId, id) {
        return findById(state.userRoleAssignments, tenantId, id, "User role assignment");
      },
      async listByTenant(tenantId) {
        return state.userRoleAssignments.filter((entry) => entry.tenant_id === tenantId);
      },
      async listByUser(tenantId, userId) {
        return state.userRoleAssignments.filter(
          (entry) => entry.tenant_id === tenantId && entry.user_id === userId
        );
      },
      async deleteById(tenantId, id) {
        const index = state.userRoleAssignments.findIndex(
          (entry) => entry.tenant_id === tenantId && entry.id === id
        );
        if (index === -1) throw new HttpError(404, "User role assignment not found");
        const [deleted] = state.userRoleAssignments.splice(index, 1);
        return deleted;
      }
    },
    deviceCredentials: {
      async create(record) {
        state.deviceCredentials.push(record);
        return record;
      },
      async listByDevice(tenantId, deviceId) {
        return state.deviceCredentials.filter(
          (entry) => entry.tenant_id === tenantId && entry.device_id === deviceId
        );
      },
      async findById(tenantId, id) {
        return findById(state.deviceCredentials, tenantId, id, "Device credential");
      },
      async findActiveByTokenHash(tokenHash) {
        return (
          state.deviceCredentials.find(
            (entry) => entry.token_hash === tokenHash && entry.status === "active" && !entry.revoked_at
          ) ?? null
        );
      },
      async update(record) {
        const index = state.deviceCredentials.findIndex((entry) => entry.id === record.id);
        if (index === -1) {
          throw new HttpError(404, "Device credential not found");
        }
        state.deviceCredentials[index] = record;
        return record;
      }
    },
    deviceAssignments: {
      async findActiveByDeviceId(tenantId, deviceId) {
        return ensureTenant(
          state.deviceAssignments.find((entry) => entry.device_id === deviceId && entry.active),
          tenantId,
          "Device assignment"
        );
      },
      async listByEvent(tenantId, eventId) {
        return state.deviceAssignments.filter(
          (entry) => entry.tenant_id === tenantId && entry.event_id === eventId && entry.active
        );
      },
      async listByStall(tenantId, stallId) {
        return state.deviceAssignments.filter(
          (entry) => entry.tenant_id === tenantId && entry.stall_id === stallId && entry.active
        );
      },
      async create(record) {
        state.deviceAssignments.push(record);
        return record;
      },
      async update(record) {
        const index = state.deviceAssignments.findIndex((entry) => entry.id === record.id);
        if (index === -1) throw new HttpError(404, "Device assignment not found");
        state.deviceAssignments[index] = record;
        return record;
      }
    },
    heartbeats: {
      async findBySourceCursor(sourceCursor) {
        return state.heartbeats.find((entry) => entry.source_cursor === sourceCursor) ?? null;
      },
      async create(record) {
        state.heartbeats.push(record);
        return record;
      },
      async listByDevice(tenantId, deviceId) {
        return state.heartbeats.filter((entry) => entry.tenant_id === tenantId && entry.device_id === deviceId);
      },
      async listByEvent(tenantId, eventId) {
        return state.heartbeats.filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId);
      }
    },
    incidents: {
      async findBySourceCursor(sourceCursor) {
        return state.incidents.find((entry) => entry.source_cursor === sourceCursor) ?? null;
      },
      async create(record) {
        state.incidents.push(record);
        return record;
      },
      async listByDevice(tenantId, deviceId) {
        return state.incidents.filter((entry) => entry.tenant_id === tenantId && entry.device_id === deviceId);
      },
      async listByEvent(tenantId, eventId) {
        return state.incidents.filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId);
      },
      async update(record) {
        const index = state.incidents.findIndex((entry) => entry.id === record.id);
        if (index === -1) {
          throw new HttpError(404, "Incident not found");
        }
        state.incidents[index] = record;
        return record;
      }
    },
    attendees: {
      async create(record) {
        state.attendees.push(record);
        return record;
      },
      async findById(tenantId, id) {
        return findById(state.attendees, tenantId, id, "Attendee");
      }
    },
    attendeeProfiles: {
      async findByAttendeeId(attendeeId) {
        return state.attendeeProfiles.find((entry) => entry.attendee_id === attendeeId) ?? null;
      },
      async upsert(record) {
        const index = state.attendeeProfiles.findIndex((entry) => entry.attendee_id === record.attendee_id);
        if (index === -1) {
          state.attendeeProfiles.push(record);
          return record;
        }
        state.attendeeProfiles[index] = record;
        return record;
      }
    },
    tapEvents: {
      async findByIdempotencyKey(tenantId, deviceId, localEventId) {
        return state.tapEvents.find(
          (entry) =>
            entry.tenant_id === tenantId &&
            entry.device_id === deviceId &&
            entry.local_event_id === localEventId
        ) ?? null;
      },
      async create(record) {
        state.tapEvents.push(record);
        return record;
      },
      async listByEvent(tenantId, eventId) {
        return state.tapEvents.filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId);
      }
    },
    interactions: {
      async create(record) {
        state.interactions.push(record);
        return record;
      },
      async findById(tenantId, id) {
        return findById(state.interactions, tenantId, id, "Interaction");
      },
      async findByTapEventId(tenantId, tapEventId) {
        return state.interactions.find(
          (entry) => entry.tenant_id === tenantId && entry.tap_event_id === tapEventId
        ) ?? null;
      },
      async listByStall(tenantId, stallId) {
        return state.interactions.filter((entry) => entry.tenant_id === tenantId && entry.stall_id === stallId);
      },
      async listByEvent(tenantId, eventId) {
        return state.interactions.filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId);
      },
      async update(record) {
        const index = state.interactions.findIndex((entry) => entry.id === record.id);
        if (index === -1) {
          throw new HttpError(404, "Interaction not found");
        }
        state.interactions[index] = record;
        return record;
      }
    },
    consents: {
      async findByInteractionId(tenantId, interactionId) {
        return state.consents.find(
          (entry) => entry.tenant_id === tenantId && entry.interaction_id === interactionId
        ) ?? null;
      },
      async upsert(record) {
        const index = state.consents.findIndex((entry) => entry.interaction_id === record.interaction_id);
        if (index === -1) {
          state.consents.push(record);
          return record;
        }
        state.consents[index] = record;
        return record;
      }
    },
    consentEvents: {
      async create(record) {
        state.consentEvents.push(record);
        return record;
      },
      async listByInteraction(tenantId, interactionId) {
        return state.consentEvents
          .filter((entry) => entry.tenant_id === tenantId && entry.interaction_id === interactionId)
          .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
      }
    },
    communicationChannelConsents: {
      async upsert(record) {
        const index = state.communicationChannelConsents.findIndex(
          (entry) => entry.interaction_id === record.interaction_id && entry.channel === record.channel
        );
        if (index === -1) {
          state.communicationChannelConsents.push(record);
          return record;
        }
        state.communicationChannelConsents[index] = {
          ...state.communicationChannelConsents[index],
          ...record
        };
        return state.communicationChannelConsents[index];
      },
      async findByInteractionAndChannel(tenantId, interactionId, channel) {
        return state.communicationChannelConsents.find(
          (entry) => entry.tenant_id === tenantId && entry.interaction_id === interactionId && entry.channel === channel
        ) ?? null;
      },
      async listByInteraction(tenantId, interactionId) {
        return state.communicationChannelConsents.filter(
          (entry) => entry.tenant_id === tenantId && entry.interaction_id === interactionId
        );
      }
    },
    communicationSuppressions: {
      async create(record) {
        state.communicationSuppressions.push(record);
        return record;
      },
      async findActiveByInteractionAndChannel(tenantId, interactionId, channel) {
        return state.communicationSuppressions.find(
          (entry) =>
            entry.tenant_id === tenantId &&
            entry.interaction_id === interactionId &&
            entry.channel === channel &&
            entry.status === "active"
        ) ?? null;
      },
      async listByInteraction(tenantId, interactionId) {
        return state.communicationSuppressions.filter(
          (entry) => entry.tenant_id === tenantId && entry.interaction_id === interactionId
        );
      },
      async deactivateByInteractionAndChannel(tenantId, interactionId, channel, now) {
        const updated = [];
        for (const record of state.communicationSuppressions) {
          if (
            record.tenant_id === tenantId &&
            record.interaction_id === interactionId &&
            record.channel === channel &&
            record.status === "active"
          ) {
            record.status = "inactive";
            record.updated_at = now;
            updated.push(record);
          }
        }
        return updated;
      }
    },
    interactionNotes: {
      async create(record) {
        state.interactionNotes.push(record);
        return record;
      },
      async listByInteraction(tenantId, interactionId) {
        return state.interactionNotes.filter(
          (entry) => entry.tenant_id === tenantId && entry.interaction_id === interactionId
        );
      }
    },
    shortLinks: {
      async create(record) {
        state.shortLinks.push(record);
        return record;
      },
      async findByTokenHash(tokenHash) {
        return state.shortLinks.find((entry) => entry.token_hash === tokenHash) ?? null;
      },
      async findById(tenantId, id) {
        return findById(state.shortLinks, tenantId, id, "Short link");
      },
      async listByTenant(tenantId) {
        return state.shortLinks.filter((entry) => entry.tenant_id === tenantId);
      },
      async update(record) {
        const index = state.shortLinks.findIndex((entry) => entry.id === record.id);
        if (index === -1) {
          throw new HttpError(404, "Short link not found");
        }
        state.shortLinks[index] = record;
        return record;
      }
    },
    walletPasses: {
      async create(record) {
        state.walletPasses.push(record);
        return record;
      },
      async findById(tenantId, id) {
        return findById(state.walletPasses, tenantId, id, "Wallet pass");
      },
      async listByInteraction(tenantId, interactionId) {
        return state.walletPasses
          .filter((entry) => entry.tenant_id === tenantId && entry.interaction_id === interactionId)
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
      },
      async listByEvent(tenantId, eventId) {
        return state.walletPasses
          .filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId)
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
      },
      async update(record) {
        const index = state.walletPasses.findIndex((entry) => entry.id === record.id);
        if (index === -1) {
          throw new HttpError(404, "Wallet pass not found");
        }
        state.walletPasses[index] = record;
        return record;
      }
    },
    walletPassAttempts: {
      async create(record) {
        state.walletPassAttempts.push(record);
        return record;
      },
      async listByWalletPass(tenantId, walletPassId) {
        return state.walletPassAttempts
          .filter((entry) => entry.tenant_id === tenantId && entry.wallet_pass_id === walletPassId)
          .sort((left, right) => Date.parse(left.attempted_at) - Date.parse(right.attempted_at));
      },
      async listByEvent(tenantId, eventId) {
        return state.walletPassAttempts
          .filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId)
          .sort((left, right) => Date.parse(right.attempted_at) - Date.parse(left.attempted_at));
      }
    },
    notifications: {
      async create(record) {
        state.notifications.push(record);
        return record;
      },
      async findById(tenantId, id) {
        return findById(state.notifications, tenantId, id, "Notification");
      },
      async findByProviderMessageId(tenantId, providerMessageId) {
        return state.notifications.find(
          (entry) => entry.tenant_id === tenantId && entry.provider_message_id === providerMessageId
        ) ?? null;
      },
      async listByEvent(tenantId, eventId) {
        return state.notifications
          .filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId)
          .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
      },
      async update(record) {
        const index = state.notifications.findIndex((entry) => entry.id === record.id);
        if (index === -1) {
          throw new HttpError(404, "Notification not found");
        }
        state.notifications[index] = record;
        return record;
      },
      async listQueued(tenantId, options = {}) {
        const limit = Number(options.limit ?? 20);
        const now = Date.parse(options.now ?? new Date().toISOString());
        return state.notifications
          .filter((entry) =>
            entry.tenant_id === tenantId &&
            (!options.eventId || entry.event_id === options.eventId) &&
            entry.status === "queued" &&
            (!entry.next_attempt_at || Date.parse(entry.next_attempt_at) <= now)
          )
          .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at))
          .slice(0, limit);
      },
      async countByStatus(tenantId, eventId) {
        return state.notifications
          .filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId)
          .reduce((acc, entry) => {
            acc[entry.status] = (acc[entry.status] ?? 0) + 1;
            return acc;
          }, {});
      }
    },
    notificationAttempts: {
      async create(record) {
        state.notificationAttempts.push(record);
        return record;
      },
      async listByEvent(tenantId, eventId) {
        const notificationsById = new Map(
          state.notifications
            .filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId)
            .map((entry) => [entry.id, entry])
        );
        return state.notificationAttempts
          .filter((entry) => entry.tenant_id === tenantId && notificationsById.has(entry.notification_id))
          .map((entry) => {
            const notification = notificationsById.get(entry.notification_id);
            return {
              ...entry,
              event_id: notification?.event_id ?? null,
              interaction_id: notification?.interaction_id ?? null,
              channel: notification?.channel ?? null
            };
          })
          .sort((left, right) => Date.parse(right.attempted_at) - Date.parse(left.attempted_at));
      },
      async listByNotification(tenantId, notificationId) {
        return state.notificationAttempts
          .filter((entry) => entry.tenant_id === tenantId && entry.notification_id === notificationId)
          .sort((left, right) => Date.parse(left.attempted_at) - Date.parse(right.attempted_at));
      }
    },
    notificationReceipts: {
      async create(record) {
        state.notificationReceipts.push(record);
        return record;
      },
      async findByDedupeKey(tenantId, dedupeKey) {
        return state.notificationReceipts.find(
          (entry) => entry.tenant_id === tenantId && entry.dedupe_key === dedupeKey
        ) ?? null;
      },
      async listByNotification(tenantId, notificationId) {
        return state.notificationReceipts
          .filter((entry) => entry.tenant_id === tenantId && entry.notification_id === notificationId)
          .sort((left, right) =>
            Date.parse(right.occurred_at ?? right.received_at) - Date.parse(left.occurred_at ?? left.received_at)
          );
      },
      async listByEvent(tenantId, eventId) {
        const notificationsById = new Map(
          state.notifications
            .filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId)
            .map((entry) => [entry.id, entry])
        );
        return state.notificationReceipts
          .filter((entry) => entry.tenant_id === tenantId && notificationsById.has(entry.notification_id))
          .map((entry) => {
            const notification = notificationsById.get(entry.notification_id);
            return {
              ...entry,
              event_id: notification?.event_id ?? null,
              interaction_id: notification?.interaction_id ?? null
            };
          })
          .sort((left, right) =>
            Date.parse(right.occurred_at ?? right.received_at) - Date.parse(left.occurred_at ?? left.received_at)
          );
      }
    },
    followupMessages: {
      async create(record) {
        state.followupMessages.push(record);
        return record;
      },
      async findById(tenantId, id) {
        return findById(state.followupMessages, tenantId, id, "Follow-up message");
      },
      async findByNotificationId(tenantId, notificationId) {
        return state.followupMessages.find(
          (entry) => entry.tenant_id === tenantId && entry.notification_id === notificationId
        ) ?? null;
      },
      async listByStall(tenantId, stallId) {
        return state.followupMessages.filter(
          (entry) => entry.tenant_id === tenantId && entry.stall_id === stallId
        );
      },
      async listByInteraction(tenantId, interactionId) {
        return state.followupMessages.filter(
          (entry) => entry.tenant_id === tenantId && entry.interaction_id === interactionId
        );
      },
      async update(record) {
        const index = state.followupMessages.findIndex((entry) => entry.id === record.id);
        if (index === -1) {
          throw new HttpError(404, "Follow-up message not found");
        }
        state.followupMessages[index] = record;
        return record;
      }
    },
    leadScores: {
      async create(record) {
        state.leadScores.push(record);
        return record;
      },
      async listByInteraction(tenantId, interactionId) {
        return state.leadScores
          .filter((entry) => entry.tenant_id === tenantId && entry.interaction_id === interactionId)
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
      }
    },
    exportRequests: {
      async create(record) {
        state.exportRequests.push(record);
        return record;
      },
      async listByEvent(tenantId, eventId) {
        return state.exportRequests.filter(
          (entry) => entry.tenant_id === tenantId && entry.event_id === eventId
        );
      },
      async findById(tenantId, id) {
        return findById(state.exportRequests, tenantId, id, "Export request");
      },
      async update(record) {
        const index = state.exportRequests.findIndex((entry) => entry.id === record.id);
        if (index === -1) {
          throw new HttpError(404, "Export request not found");
        }
        state.exportRequests[index] = record;
        return record;
      }
    },
    breakGlassAccess: {
      async create(record) {
        state.breakGlassAccess.push(record);
        return record;
      },
      async listByTenant(tenantId) {
        return state.breakGlassAccess.filter((entry) => entry.tenant_id === tenantId);
      },
      async findById(tenantId, id) {
        return findById(state.breakGlassAccess, tenantId, id, "Break-glass request");
      },
      async update(record) {
        const index = state.breakGlassAccess.findIndex((entry) => entry.id === record.id);
        if (index === -1) {
          throw new HttpError(404, "Break-glass request not found");
        }
        state.breakGlassAccess[index] = record;
        return record;
      },
      async listApprovedExpired(tenantId, nowIso) {
        return state.breakGlassAccess.filter(
          (entry) =>
            entry.tenant_id === tenantId &&
            entry.status === "active" &&
            entry.expires_at &&
            Date.parse(entry.expires_at) <= Date.parse(nowIso)
        );
      }
    },
    auditLogs: {
      async create(record) {
        state.auditLogs.push(record);
        return record;
      },
      async listByTenant(tenantId) {
        return state.auditLogs.filter((entry) => entry.tenant_id === tenantId);
      }
    },
    pentestFindings: {
      async create(record) {
        state.pentestFindings.push(record);
        return record;
      },
      async listByTenant(tenantId) {
        return state.pentestFindings
          .filter((entry) => entry.tenant_id === tenantId)
          .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
      },
      async findById(tenantId, id) {
        return findById(state.pentestFindings, tenantId, id, "Pen-test finding");
      },
      async update(record) {
        const index = state.pentestFindings.findIndex((entry) => entry.tenant_id === record.tenant_id && entry.id === record.id);
        if (index === -1) {
          throw new HttpError(404, "Pen-test finding not found");
        }
        state.pentestFindings[index] = record;
        return record;
      }
    },
    reportSnapshots: {
      async create(record) {
        state.reportSnapshots.push(record);
        return record;
      },
      async listByEvent(tenantId, eventId) {
        return state.reportSnapshots
          .filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId)
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
      }
    },
    leaderboardSnapshots: {
      async create(record) {
        state.leaderboardSnapshots.push(record);
        return record;
      },
      async listByEvent(tenantId, eventId) {
        return state.leaderboardSnapshots
          .filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId)
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
      }
    },
    crmSyncRecords: {
      async upsert(record) {
        const index = state.crmSyncRecords.findIndex(
          (entry) =>
            entry.tenant_id === record.tenant_id &&
            entry.interaction_id === record.interaction_id &&
            entry.provider === record.provider
        );
        if (index === -1) {
          state.crmSyncRecords.push(record);
          return record;
        }
        state.crmSyncRecords[index] = record;
        return record;
      },
      async listByEvent(tenantId, eventId) {
        return state.crmSyncRecords
          .filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId)
          .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
      },
      async listByInteraction(tenantId, interactionId) {
        return state.crmSyncRecords
          .filter((entry) => entry.tenant_id === tenantId && entry.interaction_id === interactionId)
          .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
      },
      async findByInteractionAndProvider(tenantId, interactionId, provider) {
        return (
          state.crmSyncRecords.find(
            (entry) =>
              entry.tenant_id === tenantId &&
              entry.interaction_id === interactionId &&
              entry.provider === provider
          ) ?? null
        );
      },
      async findById(tenantId, id) {
        return findById(state.crmSyncRecords, tenantId, id, "CRM sync record");
      }
    },
    dataSubjectRequests: {
      async create(record) {
        state.dataSubjectRequests.push(record);
        return record;
      },
      async listByEvent(tenantId, eventId) {
        return state.dataSubjectRequests
          .filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId)
          .sort((a, b) => Date.parse(b.submitted_at ?? b.created_at) - Date.parse(a.submitted_at ?? a.created_at));
      },
      async listByEventFiltered(tenantId, eventId, filters = {}) {
        let results = state.dataSubjectRequests.filter(
          (entry) => entry.tenant_id === tenantId && entry.event_id === eventId
        );
        if (filters.request_type) results = results.filter((e) => e.request_type === filters.request_type);
        if (filters.status) results = results.filter((e) => e.status === filters.status);
        results = results.sort((a, b) => Date.parse(b.submitted_at ?? b.created_at) - Date.parse(a.submitted_at ?? a.created_at));
        const page = filters.page ?? 1;
        const pageSize = filters.page_size ?? 20;
        return { items: results.slice((page - 1) * pageSize, page * pageSize), total: results.length };
      },
      async listByAttendee(tenantId, attendeeId) {
        return state.dataSubjectRequests
          .filter((entry) => entry.tenant_id === tenantId && entry.attendee_id === attendeeId)
          .sort((a, b) => Date.parse(b.submitted_at ?? b.created_at) - Date.parse(a.submitted_at ?? a.created_at));
      },
      async findActiveByAttendeeEventType(tenantId, attendeeId, eventId, requestType) {
        return state.dataSubjectRequests.find(
          (e) =>
            e.tenant_id === tenantId &&
            e.attendee_id === attendeeId &&
            e.event_id === eventId &&
            e.request_type === requestType &&
            ["requested", "processing"].includes(e.status)
        ) ?? null;
      },
      async findById(tenantId, id) {
        return findById(state.dataSubjectRequests, tenantId, id, "Data-subject request");
      },
      async update(record) {
        const index = state.dataSubjectRequests.findIndex((entry) => entry.id === record.id);
        if (index === -1) {
          throw new HttpError(404, "Data-subject request not found");
        }
        state.dataSubjectRequests[index] = record;
        return record;
      }
    },
    downstreamDeletionRecords: {
      async create(record) {
        state.downstreamDeletionRecords.push(record);
        return record;
      },
      async listByEvent(tenantId, eventId) {
        return state.downstreamDeletionRecords
          .filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId)
          .sort((left, right) => Date.parse(right.requested_at) - Date.parse(left.requested_at));
      },
      async listByRequest(tenantId, dsrRequestId) {
        return state.downstreamDeletionRecords
          .filter((entry) => entry.tenant_id === tenantId && entry.dsr_request_id === dsrRequestId)
          .sort((left, right) => Date.parse(right.requested_at) - Date.parse(left.requested_at));
      },
      async findById(tenantId, id) {
        return findById(state.downstreamDeletionRecords, tenantId, id, "Downstream deletion record");
      },
      async update(record) {
        const index = state.downstreamDeletionRecords.findIndex((entry) => entry.id === record.id);
        if (index === -1) {
          throw new HttpError(404, "Downstream deletion record not found");
        }
        state.downstreamDeletionRecords[index] = record;
        return record;
      }
    },
    complianceRuns: {
      async create(record) {
        state.complianceRuns.push(record);
        return record;
      },
      async listByEvent(tenantId, eventId) {
        return state.complianceRuns
          .filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId)
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
      },
      async findLatestByEvent(tenantId, eventId) {
        return state.complianceRuns
          .filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId)
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0] ?? null;
      }
    },
    pilotDryRunRecords: {
      async create(record) {
        state.pilotDryRunRecords.push(record);
        return record;
      },
      async listByEvent(tenantId, eventId) {
        return state.pilotDryRunRecords
          .filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId)
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
      },
      async findLatestByEvent(tenantId, eventId) {
        return state.pilotDryRunRecords
          .filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId)
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0] ?? null;
      }
    },
    pilotSignoffApprovals: {
      async upsert(record) {
        const index = state.pilotSignoffApprovals.findIndex(
          (entry) =>
            entry.tenant_id === record.tenant_id &&
            entry.event_id === record.event_id &&
            entry.approver_role === record.approver_role
        );
        if (index === -1) {
          state.pilotSignoffApprovals.push(record);
          return record;
        }
        state.pilotSignoffApprovals[index] = record;
        return record;
      },
      async listByEvent(tenantId, eventId) {
        return state.pilotSignoffApprovals
          .filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId)
          .sort((left, right) => left.approver_role.localeCompare(right.approver_role));
      }
    },
    finalLaunchApprovals: {
      async upsert(record) {
        const index = state.finalLaunchApprovals.findIndex(
          (entry) =>
            entry.tenant_id === record.tenant_id &&
            entry.event_id === record.event_id &&
            entry.approver_role === record.approver_role
        );
        if (index === -1) {
          state.finalLaunchApprovals.push(record);
          return record;
        }
        state.finalLaunchApprovals[index] = record;
        return record;
      },
      async listByEvent(tenantId, eventId) {
        return state.finalLaunchApprovals
          .filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId)
          .sort((left, right) => left.approver_role.localeCompare(right.approver_role));
      }
    },
    commercialPartners: {
      async create(record) {
        state.commercialPartners.push(record);
        return record;
      },
      async findById(tenantId, id) {
        return findById(state.commercialPartners, tenantId, id, "Commercial partner");
      },
      async listByTenant(tenantId) {
        return state.commercialPartners
          .filter((entry) => entry.tenant_id === tenantId)
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
      },
      async update(record) {
        const index = state.commercialPartners.findIndex((entry) => entry.id === record.id);
        if (index === -1) {
          throw new HttpError(404, "Commercial partner not found");
        }
        state.commercialPartners[index] = record;
        return record;
      }
    },
    commercialDeals: {
      async create(record) {
        state.commercialDeals.push(record);
        return record;
      },
      async findById(tenantId, id) {
        return findById(state.commercialDeals, tenantId, id, "Commercial deal");
      },
      async listByTenant(tenantId) {
        return state.commercialDeals
          .filter((entry) => entry.tenant_id === tenantId)
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
      },
      async update(record) {
        const index = state.commercialDeals.findIndex((entry) => entry.id === record.id);
        if (index === -1) {
          throw new HttpError(404, "Commercial deal not found");
        }
        state.commercialDeals[index] = record;
        return record;
      }
    },
    commercialPartnerPayouts: {
      async create(record) {
        state.commercialPartnerPayouts.push(record);
        return record;
      },
      async findById(tenantId, id) {
        return findById(state.commercialPartnerPayouts, tenantId, id, "Commercial partner payout");
      },
      async listByTenant(tenantId) {
        return state.commercialPartnerPayouts
          .filter((entry) => entry.tenant_id === tenantId)
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
      },
      async update(record) {
        const index = state.commercialPartnerPayouts.findIndex((entry) => entry.id === record.id);
        if (index === -1) {
          throw new HttpError(404, "Commercial partner payout not found");
        }
        state.commercialPartnerPayouts[index] = record;
        return record;
      }
    },
    commercialApprovals: {
      async create(record) {
        state.commercialApprovals.push(record);
        return record;
      },
      async listByTenant(tenantId) {
        return state.commercialApprovals
          .filter((entry) => entry.tenant_id === tenantId)
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
      }
    },
    commercialPartnerStatusUpdates: {
      async create(record) {
        state.commercialPartnerStatusUpdates.push(record);
        return record;
      },
      async listByPartner(tenantId, partnerId) {
        return state.commercialPartnerStatusUpdates
          .filter((entry) => entry.tenant_id === tenantId && entry.partner_id === partnerId)
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
      }
    },
    iotSyncCheckpoints: {
      async findByIntegrationAndStream(integrationName, streamName) {
        return (
          state.iotSyncCheckpoints.find(
            (entry) => entry.integration_name === integrationName && entry.stream_name === streamName
          ) ?? null
        );
      },
      async upsert(record) {
        const index = state.iotSyncCheckpoints.findIndex(
          (entry) => entry.integration_name === record.integration_name && entry.stream_name === record.stream_name
        );
        if (index === -1) {
          state.iotSyncCheckpoints.push(record);
          return record;
        }
        state.iotSyncCheckpoints[index] = record;
        return record;
      }
    },
    iotCertificationStatuses: {
      async findByIntegration(integrationName) {
        return state.iotCertificationStatuses.find((entry) => entry.integration_name === integrationName) ?? null;
      },
      async upsert(record) {
        const index = state.iotCertificationStatuses.findIndex(
          (entry) => entry.integration_name === record.integration_name
        );
        if (index === -1) {
          state.iotCertificationStatuses.push(record);
          return record;
        }
        state.iotCertificationStatuses[index] = record;
        return record;
      }
    },
    iotDeviceStatusSnapshots: {
      async findByDevice(tenantId, integrationName, deviceId) {
        return (
          state.iotDeviceStatusSnapshots.find(
            (entry) =>
              entry.tenant_id === tenantId &&
              entry.integration_name === integrationName &&
              entry.device_id === deviceId
          ) ?? null
        );
      },
      async listByEvent(tenantId, eventId) {
        return state.iotDeviceStatusSnapshots.filter(
          (entry) => entry.tenant_id === tenantId && entry.event_id === eventId
        );
      },
      async upsert(record) {
        const index = state.iotDeviceStatusSnapshots.findIndex(
          (entry) =>
            entry.integration_name === record.integration_name &&
            entry.device_id === record.device_id
        );
        if (index === -1) {
          state.iotDeviceStatusSnapshots.push(record);
          return record;
        }
        state.iotDeviceStatusSnapshots[index] = record;
        return record;
      },
      async deleteOlderThanByEvent(tenantId, eventId, olderThanIso) {
        const before = state.iotDeviceStatusSnapshots.length;
        state.iotDeviceStatusSnapshots = state.iotDeviceStatusSnapshots.filter(
          (entry) =>
            !(
              entry.tenant_id === tenantId &&
              entry.event_id === eventId &&
              entry.checked_at &&
              Date.parse(entry.checked_at) < Date.parse(olderThanIso)
            )
        );
        return before - state.iotDeviceStatusSnapshots.length;
      }
    },
    iotIntegrationHealthStatuses: {
      async findByEvent(tenantId, integrationName, eventId) {
        return (
          state.iotIntegrationHealthStatuses.find(
            (entry) =>
              entry.tenant_id === tenantId &&
              entry.integration_name === integrationName &&
              entry.event_id === eventId
          ) ?? null
        );
      },
      async upsert(record) {
        const index = state.iotIntegrationHealthStatuses.findIndex(
          (entry) =>
            entry.integration_name === record.integration_name &&
            entry.tenant_id === record.tenant_id &&
            entry.event_id === record.event_id
        );
        if (index === -1) {
          state.iotIntegrationHealthStatuses.push(record);
          return record;
        }
        state.iotIntegrationHealthStatuses[index] = record;
        return record;
      }
    },
    iotIntegrationRuns: {
      async create(record) {
        state.iotIntegrationRuns.push(record);
        return record;
      },
      async update(record) {
        const index = state.iotIntegrationRuns.findIndex((entry) => entry.id === record.id);
        if (index === -1) {
          throw new HttpError(404, "IoT integration run not found");
        }
        state.iotIntegrationRuns[index] = record;
        return record;
      },
      async listByEvent(tenantId, eventId, options = {}) {
        const limit = Number(options.limit ?? 20);
        return state.iotIntegrationRuns
          .filter((entry) => entry.tenant_id === tenantId && entry.event_id === eventId)
          .sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at))
          .slice(0, limit);
      },
      async findLatestByEvent(tenantId, integrationName, eventId) {
        return (
          state.iotIntegrationRuns
            .filter(
              (entry) =>
                entry.tenant_id === tenantId &&
                entry.integration_name === integrationName &&
                entry.event_id === eventId
            )
            .sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at))[0] ?? null
        );
      },
      async deleteOlderThanByEvent(tenantId, eventId, olderThanIso) {
        const before = state.iotIntegrationRuns.length;
        state.iotIntegrationRuns = state.iotIntegrationRuns.filter(
          (entry) =>
            !(
              entry.tenant_id === tenantId &&
              entry.event_id === eventId &&
              entry.started_at &&
              Date.parse(entry.started_at) < Date.parse(olderThanIso)
            )
        );
        return before - state.iotIntegrationRuns.length;
      }
    },
    iotAlertEvents: {
      async findByDedupeKey(tenantId, dedupeKey) {
        return (
          state.iotAlertEvents.find(
            (entry) => entry.tenant_id === tenantId && entry.dedupe_key === dedupeKey
          ) ?? null
        );
      },
      async upsert(record) {
        const index = state.iotAlertEvents.findIndex((entry) => entry.dedupe_key === record.dedupe_key);
        if (index === -1) {
          state.iotAlertEvents.push(record);
          return record;
        }
        state.iotAlertEvents[index] = {
          ...state.iotAlertEvents[index],
          ...record
        };
        return state.iotAlertEvents[index];
      },
      async listByEvent(tenantId, eventId, options = {}) {
        const limit = Number(options.limit ?? 20);
        return state.iotAlertEvents
          .filter(
            (entry) =>
              entry.tenant_id === tenantId &&
              entry.event_id === eventId &&
              (!options.status || entry.status === options.status)
          )
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
          .slice(0, limit);
      },
      async countOpenByEvent(tenantId, eventId) {
        return state.iotAlertEvents.filter(
          (entry) => entry.tenant_id === tenantId && entry.event_id === eventId && entry.status === "open"
        ).length;
      },
      async resolveOpenByCodes(tenantId, eventId, codes, resolvedAt) {
        let count = 0;
        for (const entry of state.iotAlertEvents) {
          if (
            entry.tenant_id === tenantId &&
            entry.event_id === eventId &&
            entry.status === "open" &&
            codes.includes(entry.code)
          ) {
            entry.status = "resolved";
            entry.updated_at = resolvedAt;
            count += 1;
          }
        }
        return count;
      },
      async deleteOlderThanByEvent(tenantId, eventId, olderThanIso) {
        const before = state.iotAlertEvents.length;
        state.iotAlertEvents = state.iotAlertEvents.filter(
          (entry) =>
            !(
              entry.tenant_id === tenantId &&
              entry.event_id === eventId &&
              entry.updated_at &&
              Date.parse(entry.updated_at) < Date.parse(olderThanIso)
            )
        );
        return before - state.iotAlertEvents.length;
      }
    },
    iotEnvironmentParityStatuses: {
      async findByEvent(tenantId, integrationName, eventId) {
        return (
          state.iotEnvironmentParityStatuses.find(
            (entry) =>
              entry.tenant_id === tenantId &&
              entry.integration_name === integrationName &&
              entry.event_id === eventId
          ) ?? null
        );
      },
      async upsert(record) {
        const index = state.iotEnvironmentParityStatuses.findIndex(
          (entry) =>
            entry.integration_name === record.integration_name &&
            entry.tenant_id === record.tenant_id &&
            entry.event_id === record.event_id
        );
        if (index === -1) {
          state.iotEnvironmentParityStatuses.push(record);
          return record;
        }
        state.iotEnvironmentParityStatuses[index] = {
          ...state.iotEnvironmentParityStatuses[index],
          ...record
        };
        return state.iotEnvironmentParityStatuses[index];
      },
      async deleteOlderThanByEvent(tenantId, eventId, olderThanIso) {
        const before = state.iotEnvironmentParityStatuses.length;
        state.iotEnvironmentParityStatuses = state.iotEnvironmentParityStatuses.filter(
          (entry) =>
            !(
              entry.tenant_id === tenantId &&
              entry.event_id === eventId &&
              entry.checked_at &&
              Date.parse(entry.checked_at) < Date.parse(olderThanIso)
            )
        );
        return before - state.iotEnvironmentParityStatuses.length;
      }
    },
    apiClients: {
      async create(record) {
        state.apiClients.push(record);
        return record;
      },
      async listByTenant(tenantId) {
        return state.apiClients.filter((entry) => entry.tenant_id === tenantId);
      },
      async findById(tenantId, id) {
        return findById(state.apiClients, tenantId, id, "API client");
      },
      async findBySecretHash(secretHash) {
        return state.apiClients.find((entry) => entry.client_secret_hash === secretHash) ?? null;
      },
      async update(record) {
        const index = state.apiClients.findIndex((entry) => entry.id === record.id);
        if (index === -1) throw new HttpError(404, "API client not found");
        state.apiClients[index] = record;
        return record;
      }
    },
    nfcReaders: {
      async create(record) {
        state.nfcReaders.push(record);
        return record;
      },
      async findById(tenantId, id) {
        return findById(state.nfcReaders, tenantId, id, "NFC reader");
      },
      async findByDevice(tenantId, deviceId) {
        return state.nfcReaders.find((r) => r.tenant_id === tenantId && r.device_id === deviceId) ?? null;
      },
      async update(record) {
        const index = state.nfcReaders.findIndex((r) => r.id === record.id);
        if (index === -1) throw new HttpError(404, "NFC reader not found");
        state.nfcReaders[index] = record;
        return record;
      }
    },
    privacyAuditLogs: {
      async create(record) {
        state.privacyAuditLogs.push(record);
        return record;
      },
      async listByTenant(tenantId, filters = {}) {
        let results = state.privacyAuditLogs.filter((e) => e.tenant_id === tenantId);
        if (filters.event_id) results = results.filter((e) => e.event_id === filters.event_id);
        if (filters.action) results = results.filter((e) => e.action === filters.action);
        if (filters.actor_role) results = results.filter((e) => e.actor_role === filters.actor_role);
        if (filters.from) results = results.filter((e) => e.occurred_at >= filters.from);
        if (filters.to) results = results.filter((e) => e.occurred_at <= filters.to);
        results = results.sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
        const page = filters.page ?? 1;
        const pageSize = filters.page_size ?? 20;
        const total = results.length;
        return { entries: results.slice((page - 1) * pageSize, page * pageSize), total, page, page_size: pageSize };
      }
    },
    tenantOffboardingJobs: {
      async create(record) {
        state.tenantOffboardingJobs.push(record);
        return record;
      },
      async findById(id) {
        return state.tenantOffboardingJobs.find((e) => e.id === id) ?? null;
      },
      async findActiveByTenant(tenantId) {
        return state.tenantOffboardingJobs.find(
          (e) => e.tenant_id === tenantId && !["completed", "failed"].includes(e.status)
        ) ?? null;
      },
      async update(record) {
        const index = state.tenantOffboardingJobs.findIndex((e) => e.id === record.id);
        if (index === -1) throw new HttpError(404, "Tenant offboarding job not found");
        state.tenantOffboardingJobs[index] = record;
        return record;
      }
    },
    metrics: {
      incrementRouteHit(routeId) {
        state.metrics.routeHits[routeId] = (state.metrics.routeHits[routeId] ?? 0) + 1;
      }
    }
  };

  return repos;
}
