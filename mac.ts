#!/usr/bin/env bun

import { spawnSync } from "child_process";
import { existsSync } from "fs";

// ══════════════════════════════════════════════════════════════════════════════
// SHARED UTILITIES
// ══════════════════════════════════════════════════════════════════════════════

function runAppleScript(script: string, timeout = 60000): string {
  const result = spawnSync("osascript", ["-e", script], {
    encoding: "utf-8",
    timeout,
  });

  if (result.error) {
    throw new Error(`AppleScript error: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`AppleScript failed: ${result.stderr}`);
  }

  return result.stdout.trim();
}

function escapeAS(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function sanitizeId(id: string): string {
  if (/^\d+$/.test(id)) return id;
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// Parse natural language dates
function parseDate(input: string): Date {
  const now = new Date();
  const lower = input.toLowerCase().trim();

  // Relative dates
  if (lower === "today") return now;
  if (lower === "tomorrow") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (lower === "yesterday") {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return d;
  }

  // "next monday", "next friday", etc.
  const nextMatch = lower.match(/^next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (nextMatch) {
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const targetDay = days.indexOf(nextMatch[1]);
    const currentDay = now.getDay();
    let daysUntil = targetDay - currentDay;
    if (daysUntil <= 0) daysUntil += 7;
    const d = new Date(now);
    d.setDate(d.getDate() + daysUntil);
    return d;
  }

  // "in X days"
  const inDaysMatch = lower.match(/^in\s+(\d+)\s+days?$/);
  if (inDaysMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() + parseInt(inDaysMatch[1], 10));
    return d;
  }

  // Try parsing as ISO date or common formats
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) return parsed;

  throw new Error(`Could not parse date: ${input}`);
}

// Format date for display
function formatDate(date: Date): string {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const isToday = date.toDateString() === now.toDateString();
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  const timeStr = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  if (isToday) return `Today at ${timeStr}`;
  if (isTomorrow) return `Tomorrow at ${timeStr}`;

  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Format date for AppleScript
function formatDateAS(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }) + " " + date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

const DEFAULT_DOWNLOAD_DIR = "/Users/hanifcarroll/Library/Mobile Documents/com~apple~CloudDocs/Downloads";

// ══════════════════════════════════════════════════════════════════════════════
// MAIL SERVICE
// ══════════════════════════════════════════════════════════════════════════════

interface MailAccount {
  name: string;
  emails: string[];
}

interface MailMessage {
  id: string;
  subject: string;
  sender: string;
  dateReceived: string;
  isRead: boolean;
}

interface MailAttachment {
  name: string;
  mimeType: string;
  size: number;
  downloaded: boolean;
}

const mail = {
  accounts(): void {
    const script = `
      tell application "Mail"
        set output to ""
        repeat with acc in accounts
          set accName to name of acc
          set accEmails to email addresses of acc
          set output to output & accName & "|"
          repeat with addr in accEmails
            set output to output & addr & ","
          end repeat
          set output to output & "\\n"
        end repeat
        return output
      end tell
    `;

    const result = runAppleScript(script);
    const accounts: MailAccount[] = [];

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const [name, emailStr] = line.split("|");
      const emails = emailStr
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
      accounts.push({ name, emails });
    }

    console.log("\n Mail Accounts\n");
    console.log("-".repeat(50));

    for (const acc of accounts) {
      console.log(`\n  ${acc.name}`);
      for (const email of acc.emails) {
        console.log(`   ${email}`);
      }
    }
    console.log("\n");
  },

  mailboxes(account: string): void {
    const accountSafe = escapeAS(account);

    const script = `
      tell application "Mail"
        set accountRef to account "${accountSafe}"
        set output to ""
        repeat with mb in mailboxes of accountRef
          set mbName to name of mb
          set mbUnread to unread count of mb
          set output to output & mbName & "|" & mbUnread & "\\n"
        end repeat
        return output
      end tell
    `;

    const result = runAppleScript(script);

    console.log(`\n Mailboxes for "${account}"\n`);
    console.log("-".repeat(50));

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const [name, unread] = line.split("|");
      const unreadNum = parseInt(unread, 10) || 0;
      const badge = unreadNum > 0 ? ` (${unreadNum} unread)` : "";
      console.log(`   ${name}${badge}`);
    }
    console.log("\n");
  },

  search(
    account: string,
    mailbox: string = "INBOX",
    options: { sender?: string; subject?: string; unread?: boolean; limit?: number }
  ): void {
    const accountSafe = escapeAS(account);
    const mailboxSafe = escapeAS(mailbox);

    const conditions: string[] = [];
    if (options.sender) {
      conditions.push(`sender contains "${escapeAS(options.sender)}"`);
    }
    if (options.subject) {
      conditions.push(`subject contains "${escapeAS(options.subject)}"`);
    }
    if (options.unread) {
      conditions.push("read status is false");
    }

    const limit = options.limit || 20;

    const messageSelection = conditions.length > 0
      ? `(messages of mailboxRef whose ${conditions.join(" and ")})`
      : `messages of mailboxRef`;

    const script = `
      tell application "Mail"
        set accountRef to account "${accountSafe}"
        set mailboxRef to mailbox "${mailboxSafe}" of accountRef
        set matchedMessages to ${messageSelection}

        set resultList to {}
        set counter to 0
        repeat with msg in matchedMessages
          if counter >= ${limit} then exit repeat
          set msgId to id of msg as text
          set msgSubject to subject of msg
          set msgSender to sender of msg
          set msgDate to date received of msg as text
          set msgRead to read status of msg

          set msgData to msgId & "|" & msgSubject & "|" & msgSender & "|" & msgDate & "|" & msgRead
          set end of resultList to msgData
          set counter to counter + 1
        end repeat

        set AppleScript's text item delimiters to linefeed
        set output to resultList as text
        set AppleScript's text item delimiters to ""
        return output
      end tell
    `;

    const result = runAppleScript(script);
    const messages: MailMessage[] = [];

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("|");
      if (parts.length >= 5) {
        messages.push({
          id: parts[0],
          subject: parts[1],
          sender: parts[2],
          dateReceived: parts[3],
          isRead: parts[4].toLowerCase() === "true",
        });
      }
    }

    console.log(`\n Messages in ${account}/${mailbox} (${messages.length} found)\n`);
    console.log("-".repeat(70));

    for (const msg of messages) {
      const readIcon = msg.isRead ? "  " : "* ";
      const dateStr = msg.dateReceived.replace(" at ", " ").replace(/,/g, "");
      const date = new Date(dateStr);
      const formattedDate = isNaN(date.getTime()) ? msg.dateReceived : date.toLocaleDateString();
      console.log(`\n${readIcon}[${msg.id}] ${msg.subject}`);
      console.log(`   From: ${msg.sender}`);
      console.log(`   Date: ${formattedDate}`);
    }
    console.log("\n");
  },

  read(messageId: string): void {
    const idSafe = sanitizeId(messageId);

    const script = `
      tell application "Mail"
        repeat with acc in accounts
          repeat with mb in mailboxes of acc
            try
              set msg to first message of mb whose id is ${idSafe}

              set msgSubject to subject of msg
              set msgSender to sender of msg
              set msgDate to date received of msg as text
              set msgContent to content of msg
              set msgTo to ""
              repeat with r in to recipients of msg
                set msgTo to msgTo & address of r & ", "
              end repeat

              return msgSubject & "|||" & msgSender & "|||" & msgDate & "|||" & msgTo & "|||" & msgContent
            end try
          end repeat
        end repeat
        error "Message not found"
      end tell
    `;

    const result = runAppleScript(script);
    const [subject, sender, date, to, content] = result.split("|||");

    console.log("\n" + "=".repeat(70));
    console.log(` ${subject}`);
    console.log("=".repeat(70));
    console.log(`From: ${sender}`);
    console.log(`To: ${to}`);
    console.log(`Date: ${date}`);
    console.log("-".repeat(70));
    console.log(content);
    console.log("=".repeat(70) + "\n");
  },

  attachments(messageId: string): void {
    const idSafe = sanitizeId(messageId);

    const script = `
      tell application "Mail"
        repeat with acc in accounts
          repeat with mb in mailboxes of acc
            try
              set msg to first message of mb whose id is ${idSafe}
              set attList to mail attachments of msg

              set output to ""
              repeat with att in attList
                set attName to name of att
                set attType to MIME type of att
                set attSize to file size of att
                set attDownloaded to downloaded of att
                set output to output & attName & "|" & attType & "|" & attSize & "|" & attDownloaded & "\\n"
              end repeat

              return output
            end try
          end repeat
        end repeat
        error "Message not found"
      end tell
    `;

    const result = runAppleScript(script);
    const attachments: MailAttachment[] = [];

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("|");
      if (parts.length >= 4) {
        attachments.push({
          name: parts[0],
          mimeType: parts[1],
          size: parseInt(parts[2], 10) || 0,
          downloaded: parts[3].toLowerCase() === "true",
        });
      }
    }

    if (attachments.length === 0) {
      console.log("\n No attachments on this message.\n");
      return;
    }

    console.log(`\n Attachments (${attachments.length})\n`);
    console.log("-".repeat(60));

    for (const att of attachments) {
      const sizeKB = (att.size / 1024).toFixed(1);
      const status = att.downloaded ? "[x]" : "[ ]";
      console.log(`\n${status} ${att.name}`);
      console.log(`   Type: ${att.mimeType}`);
      console.log(`   Size: ${sizeKB} KB`);
    }
    console.log("\n");
  },

  saveAttachments(messageId: string, saveDir?: string): void {
    const idSafe = sanitizeId(messageId);
    const targetDir = saveDir || DEFAULT_DOWNLOAD_DIR;
    const targetDirSafe = escapeAS(targetDir);

    if (!existsSync(targetDir)) {
      console.error(`\n Error: Directory does not exist: ${targetDir}\n`);
      process.exit(1);
    }

    const script = `
      tell application "Mail"
        repeat with acc in accounts
          repeat with mb in mailboxes of acc
            try
              set msg to first message of mb whose id is ${idSafe}
              set attList to mail attachments of msg
              set saveCount to 0
              set savedNames to ""

              repeat with att in attList
                try
                  set attName to name of att
                  set savePath to "${targetDirSafe}/" & attName
                  save att in POSIX file savePath
                  set saveCount to saveCount + 1
                  set savedNames to savedNames & attName & "\\n"
                end try
              end repeat

              return saveCount & "|" & savedNames
            end try
          end repeat
        end repeat
        error "Message not found"
      end tell
    `;

    const result = runAppleScript(script);
    const [countStr, namesStr] = result.split("|");
    const count = parseInt(countStr, 10) || 0;
    const names = namesStr.split("\n").filter(Boolean);

    if (count === 0) {
      console.log("\n No attachments to save.\n");
      return;
    }

    console.log(`\n Saved ${count} attachment(s) to:`);
    console.log(`   ${targetDir}\n`);
    console.log("-".repeat(60));
    for (const name of names) {
      console.log(`   ${name}`);
    }
    console.log("\n");
  },

  draft(
    to: string[],
    subject: string,
    body: string,
    options: { cc?: string[]; bcc?: string[] }
  ): void {
    const subjectSafe = escapeAS(subject);
    const bodySafe = escapeAS(body);

    const toList = to.map((addr) => `"${escapeAS(addr)}"`).join(", ");
    const ccList = (options.cc || []).map((addr) => `"${escapeAS(addr)}"`).join(", ");
    const bccList = (options.bcc || []).map((addr) => `"${escapeAS(addr)}"`).join(", ");

    const script = `
      tell application "Mail"
        set theMessage to make new outgoing message with properties {subject:"${subjectSafe}", content:"${bodySafe}", visible:true}

        tell theMessage
          repeat with addr in {${toList}}
            make new to recipient with properties {address:addr}
          end repeat

          ${ccList ? `repeat with addr in {${ccList}}
            make new cc recipient with properties {address:addr}
          end repeat` : ""}

          ${bccList ? `repeat with addr in {${bccList}}
            make new bcc recipient with properties {address:addr}
          end repeat` : ""}
        end tell

        return id of theMessage
      end tell
    `;

    const draftId = runAppleScript(script);

    console.log("\n Draft created successfully!");
    console.log(`   Draft ID: ${draftId}`);
    console.log(`   To: ${to.join(", ")}`);
    console.log(`   Subject: ${subject}`);
    console.log("\n The draft is now open in Mail.app for review.\n");
  },

  send(
    to: string[],
    subject: string,
    body: string,
    options: { cc?: string[]; bcc?: string[]; confirm?: boolean }
  ): void {
    if (options.confirm !== false) {
      const confirmScript = `
        display dialog "Send email?\\n\\nTo: ${to.join(", ")}\\nSubject: ${escapeAS(subject)}" buttons {"Cancel", "Send"} default button "Send" with title "mac CLI" with icon caution
      `;

      try {
        runAppleScript(confirmScript);
      } catch {
        console.log("\n Send cancelled by user.\n");
        process.exit(0);
      }
    }

    const subjectSafe = escapeAS(subject);
    const bodySafe = escapeAS(body);

    const toList = to.map((addr) => `"${escapeAS(addr)}"`).join(", ");
    const ccList = (options.cc || []).map((addr) => `"${escapeAS(addr)}"`).join(", ");
    const bccList = (options.bcc || []).map((addr) => `"${escapeAS(addr)}"`).join(", ");

    const script = `
      tell application "Mail"
        set theMessage to make new outgoing message with properties {subject:"${subjectSafe}", content:"${bodySafe}", visible:false}

        tell theMessage
          repeat with addr in {${toList}}
            make new to recipient with properties {address:addr}
          end repeat

          ${ccList ? `repeat with addr in {${ccList}}
            make new cc recipient with properties {address:addr}
          end repeat` : ""}

          ${bccList ? `repeat with addr in {${bccList}}
            make new bcc recipient with properties {address:addr}
          end repeat` : ""}

          send
        end tell

        return "sent"
      end tell
    `;

    runAppleScript(script);

    console.log("\n Email sent successfully!");
    console.log(`   To: ${to.join(", ")}`);
    console.log(`   Subject: ${subject}\n`);
  },

  markRead(messageIds: string[]): void {
    mail.mark(messageIds, true);
  },

  markUnread(messageIds: string[]): void {
    mail.mark(messageIds, false);
  },

  mark(messageIds: string[], read: boolean): void {
    const ids = messageIds.map(sanitizeId).join(", ");
    const status = read ? "true" : "false";

    const script = `
      tell application "Mail"
        set idList to {${ids}}
        set updateCount to 0

        repeat with msgId in idList
          repeat with acc in accounts
            repeat with mb in mailboxes of acc
              try
                set msg to first message of mb whose id is msgId
                set read status of msg to ${status}
                set updateCount to updateCount + 1
              end try
            end repeat
          end repeat
        end repeat

        return updateCount
      end tell
    `;

    const count = runAppleScript(script);
    console.log(`\n Marked ${count} message(s) as ${read ? "read" : "unread"}.\n`);
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// CALENDAR SERVICE
// ══════════════════════════════════════════════════════════════════════════════

interface CalendarEvent {
  id: string;
  summary: string;
  startDate: string;
  endDate: string;
  location: string;
  calendar: string;
  allDay: boolean;
}

const calendar = {
  calendars(): void {
    const script = `
      tell application "Calendar"
        set output to ""
        repeat with cal in calendars
          set calName to name of cal
          set calColor to ""
          try
            set calColor to color of cal as text
          end try
          set output to output & calName & "|" & calColor & "\\n"
        end repeat
        return output
      end tell
    `;

    const result = runAppleScript(script);

    console.log("\n Calendars\n");
    console.log("-".repeat(50));

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const [name] = line.split("|");
      console.log(`   ${name}`);
    }
    console.log("\n");
  },

  list(days: number = 7): void {
    const script = `
      tell application "Calendar"
        set startDate to current date
        set endDate to startDate + ${days} * days

        set output to ""
        repeat with cal in calendars
          set calName to name of cal
          try
            set eventList to (every event of cal whose start date >= startDate and start date <= endDate)
            repeat with evt in eventList
              set evtId to uid of evt
              set evtSummary to summary of evt
              set evtStart to start date of evt as text
              set evtEnd to end date of evt as text
              set evtLoc to ""
              try
                set evtLoc to location of evt
              end try
              set evtAllDay to allday event of evt
              set output to output & evtId & "|" & evtSummary & "|" & evtStart & "|" & evtEnd & "|" & evtLoc & "|" & calName & "|" & evtAllDay & "\\n"
            end repeat
          end try
        end repeat
        return output
      end tell
    `;

    const result = runAppleScript(script, 120000); // 2 min timeout for calendar
    const events: CalendarEvent[] = [];

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("|");
      if (parts.length >= 7) {
        events.push({
          id: parts[0],
          summary: parts[1],
          startDate: parts[2],
          endDate: parts[3],
          location: parts[4],
          calendar: parts[5],
          allDay: parts[6].toLowerCase() === "true",
        });
      }
    }

    // Sort by start date
    events.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

    console.log(`\n Events (next ${days} days)\n`);
    console.log("-".repeat(60));

    if (events.length === 0) {
      console.log("\n  No events found.\n");
      return;
    }

    let currentDay = "";
    for (const evt of events) {
      const startDate = new Date(evt.startDate);
      const dayStr = startDate.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });

      if (dayStr !== currentDay) {
        currentDay = dayStr;
        console.log(`\n  ${dayStr}`);
        console.log("  " + "-".repeat(40));
      }

      const timeStr = evt.allDay ? "All day" : startDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      console.log(`    ${timeStr} - ${evt.summary}`);
      if (evt.location) {
        console.log(`      @ ${evt.location}`);
      }
      console.log(`      [${evt.calendar}]`);
    }
    console.log("\n");
  },

  today(): void {
    const script = `
      tell application "Calendar"
        set startDate to current date
        set time of startDate to 0
        set endDate to startDate + 1 * days

        set output to ""
        repeat with cal in calendars
          set calName to name of cal
          try
            set eventList to (every event of cal whose start date >= startDate and start date < endDate)
            repeat with evt in eventList
              set evtId to uid of evt
              set evtSummary to summary of evt
              set evtStart to start date of evt as text
              set evtEnd to end date of evt as text
              set evtLoc to ""
              try
                set evtLoc to location of evt
              end try
              set evtAllDay to allday event of evt
              set output to output & evtId & "|" & evtSummary & "|" & evtStart & "|" & evtEnd & "|" & evtLoc & "|" & calName & "|" & evtAllDay & "\\n"
            end repeat
          end try
        end repeat
        return output
      end tell
    `;

    const result = runAppleScript(script, 120000); // 2 min timeout
    const events: CalendarEvent[] = [];

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("|");
      if (parts.length >= 7) {
        events.push({
          id: parts[0],
          summary: parts[1],
          startDate: parts[2],
          endDate: parts[3],
          location: parts[4],
          calendar: parts[5],
          allDay: parts[6].toLowerCase() === "true",
        });
      }
    }

    events.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

    const todayStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    console.log(`\n Today - ${todayStr}\n`);
    console.log("-".repeat(50));

    if (events.length === 0) {
      console.log("\n  No events today.\n");
      return;
    }

    for (const evt of events) {
      const startDate = new Date(evt.startDate);
      const timeStr = evt.allDay ? "All day" : startDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      console.log(`\n  ${timeStr} - ${evt.summary}`);
      if (evt.location) {
        console.log(`    @ ${evt.location}`);
      }
      console.log(`    [${evt.calendar}]`);
    }
    console.log("\n");
  },

  tomorrow(): void {
    const script = `
      tell application "Calendar"
        set startDate to (current date) + 1 * days
        set time of startDate to 0
        set endDate to startDate + 1 * days

        set output to ""
        repeat with cal in calendars
          set calName to name of cal
          try
            set eventList to (every event of cal whose start date >= startDate and start date < endDate)
            repeat with evt in eventList
              set evtId to uid of evt
              set evtSummary to summary of evt
              set evtStart to start date of evt as text
              set evtEnd to end date of evt as text
              set evtLoc to ""
              try
                set evtLoc to location of evt
              end try
              set evtAllDay to allday event of evt
              set output to output & evtId & "|" & evtSummary & "|" & evtStart & "|" & evtEnd & "|" & evtLoc & "|" & calName & "|" & evtAllDay & "\\n"
            end repeat
          end try
        end repeat
        return output
      end tell
    `;

    const result = runAppleScript(script, 120000); // 2 min timeout
    const events: CalendarEvent[] = [];

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("|");
      if (parts.length >= 7) {
        events.push({
          id: parts[0],
          summary: parts[1],
          startDate: parts[2],
          endDate: parts[3],
          location: parts[4],
          calendar: parts[5],
          allDay: parts[6].toLowerCase() === "true",
        });
      }
    }

    events.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    console.log(`\n Tomorrow - ${tomorrowStr}\n`);
    console.log("-".repeat(50));

    if (events.length === 0) {
      console.log("\n  No events tomorrow.\n");
      return;
    }

    for (const evt of events) {
      const startDate = new Date(evt.startDate);
      const timeStr = evt.allDay ? "All day" : startDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      console.log(`\n  ${timeStr} - ${evt.summary}`);
      if (evt.location) {
        console.log(`    @ ${evt.location}`);
      }
      console.log(`    [${evt.calendar}]`);
    }
    console.log("\n");
  },

  show(eventId: string): void {
    const idSafe = escapeAS(eventId);

    const script = `
      tell application "Calendar"
        repeat with cal in calendars
          try
            set evt to first event of cal whose uid is "${idSafe}"
            set evtSummary to summary of evt
            set evtStart to start date of evt as text
            set evtEnd to end date of evt as text
            set evtLoc to ""
            try
              set evtLoc to location of evt
            end try
            set evtNotes to ""
            try
              set evtNotes to description of evt
            end try
            set evtAllDay to allday event of evt
            set calName to name of cal

            return evtSummary & "|||" & evtStart & "|||" & evtEnd & "|||" & evtLoc & "|||" & evtNotes & "|||" & evtAllDay & "|||" & calName
          end try
        end repeat
        error "Event not found"
      end tell
    `;

    const result = runAppleScript(script);
    const [summary, start, end, location, notes, allDay, calName] = result.split("|||");

    console.log("\n" + "=".repeat(60));
    console.log(` ${summary}`);
    console.log("=".repeat(60));
    console.log(`Calendar: ${calName}`);
    console.log(`Start: ${start}`);
    console.log(`End: ${end}`);
    if (allDay.toLowerCase() === "true") {
      console.log(`All Day: Yes`);
    }
    if (location) {
      console.log(`Location: ${location}`);
    }
    if (notes) {
      console.log("-".repeat(60));
      console.log("Notes:");
      console.log(notes);
    }
    console.log("=".repeat(60) + "\n");
  },

  add(
    title: string,
    options: { date?: string; time?: string; duration?: number; calendar?: string; location?: string; notes?: string; allDay?: boolean }
  ): void {
    const titleSafe = escapeAS(title);
    const calendarName = options.calendar || "Calendar";
    const calendarSafe = escapeAS(calendarName);
    const duration = options.duration || 60;

    let dateScript: string;
    if (options.date) {
      const parsedDate = parseDate(options.date);
      if (options.time) {
        const [hours, minutes] = options.time.split(":").map(Number);
        parsedDate.setHours(hours || 0, minutes || 0, 0, 0);
      }
      dateScript = `date "${formatDateAS(parsedDate)}"`;
    } else {
      dateScript = `(current date)`;
    }

    const locationProp = options.location ? `, location:"${escapeAS(options.location)}"` : "";
    const notesProp = options.notes ? `, description:"${escapeAS(options.notes)}"` : "";
    const allDayProp = options.allDay ? `, allday event:true` : "";

    const script = `
      tell application "Calendar"
        tell calendar "${calendarSafe}"
          set startDate to ${dateScript}
          set endDate to startDate + (${duration} * minutes)
          set newEvent to make new event with properties {summary:"${titleSafe}", start date:startDate, end date:endDate${locationProp}${notesProp}${allDayProp}}
          return uid of newEvent
        end tell
      end tell
    `;

    const eventId = runAppleScript(script);

    console.log("\n Event created successfully!");
    console.log(`   ID: ${eventId}`);
    console.log(`   Title: ${title}`);
    console.log(`   Calendar: ${calendarName}`);
    if (options.location) {
      console.log(`   Location: ${options.location}`);
    }
    console.log("\n");
  },

  delete(eventId: string): void {
    const idSafe = escapeAS(eventId);

    const script = `
      tell application "Calendar"
        repeat with cal in calendars
          try
            set evt to first event of cal whose uid is "${idSafe}"
            set evtName to summary of evt
            delete evt
            return evtName
          end try
        end repeat
        error "Event not found"
      end tell
    `;

    const eventName = runAppleScript(script);
    console.log(`\n Deleted event: ${eventName}\n`);
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// CONTACTS SERVICE
// ══════════════════════════════════════════════════════════════════════════════

interface Contact {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  company: string;
}

const contacts = {
  search(query: string): void {
    const querySafe = escapeAS(query);

    const script = `
      tell application "Contacts"
        set matchedPeople to (every person whose name contains "${querySafe}")
        set output to ""
        repeat with p in matchedPeople
          set pId to id of p
          set pName to name of p
          set pEmails to ""
          repeat with e in emails of p
            set pEmails to pEmails & value of e & ","
          end repeat
          set pPhones to ""
          repeat with ph in phones of p
            set pPhones to pPhones & value of ph & ","
          end repeat
          set pCompany to ""
          try
            set pCompany to organization of p
          end try
          set output to output & pId & "|" & pName & "|" & pEmails & "|" & pPhones & "|" & pCompany & "\\n"
        end repeat
        return output
      end tell
    `;

    const result = runAppleScript(script);
    const contactsList: Contact[] = [];

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("|");
      if (parts.length >= 5) {
        contactsList.push({
          id: parts[0],
          name: parts[1],
          emails: parts[2].split(",").filter(Boolean),
          phones: parts[3].split(",").filter(Boolean),
          company: parts[4],
        });
      }
    }

    console.log(`\n Contacts matching "${query}" (${contactsList.length} found)\n`);
    console.log("-".repeat(50));

    if (contactsList.length === 0) {
      console.log("\n  No contacts found.\n");
      return;
    }

    for (const c of contactsList) {
      console.log(`\n  ${c.name}`);
      if (c.company) {
        console.log(`    ${c.company}`);
      }
      for (const email of c.emails) {
        console.log(`    ${email}`);
      }
      for (const phone of c.phones) {
        console.log(`    ${phone}`);
      }
    }
    console.log("\n");
  },

  show(name: string): void {
    const nameSafe = escapeAS(name);

    const script = `
      tell application "Contacts"
        set matchedPeople to (every person whose name contains "${nameSafe}")
        if (count of matchedPeople) is 0 then
          error "Contact not found"
        end if

        set p to first item of matchedPeople
        set pName to name of p
        set pEmails to ""
        repeat with e in emails of p
          set pEmails to pEmails & (label of e) & ":" & (value of e) & ","
        end repeat
        set pPhones to ""
        repeat with ph in phones of p
          set pPhones to pPhones & (label of ph) & ":" & (value of ph) & ","
        end repeat
        set pCompany to ""
        try
          set pCompany to organization of p
        end try
        set pTitle to ""
        try
          set pTitle to job title of p
        end try
        set pNote to ""
        try
          set pNote to note of p
        end try
        set pBirthday to ""
        try
          set pBirthday to birth date of p as text
        end try
        set pAddresses to ""
        repeat with addr in addresses of p
          try
            set addrStr to (label of addr) & ":" & (street of addr) & ", " & (city of addr) & ", " & (state of addr) & " " & (zip of addr)
            set pAddresses to pAddresses & addrStr & ";"
          end try
        end repeat

        return pName & "|||" & pEmails & "|||" & pPhones & "|||" & pCompany & "|||" & pTitle & "|||" & pNote & "|||" & pBirthday & "|||" & pAddresses
      end tell
    `;

    const result = runAppleScript(script);
    const [cName, emails, phones, company, title, note, birthday, addresses] = result.split("|||");

    console.log("\n" + "=".repeat(60));
    console.log(` ${cName}`);
    console.log("=".repeat(60));

    if (company || title) {
      const work = [title, company].filter(Boolean).join(" at ");
      console.log(`Work: ${work}`);
    }

    if (emails) {
      console.log("\nEmail:");
      for (const e of emails.split(",").filter(Boolean)) {
        const [label, value] = e.split(":");
        console.log(`  ${label}: ${value}`);
      }
    }

    if (phones) {
      console.log("\nPhone:");
      for (const p of phones.split(",").filter(Boolean)) {
        const [label, value] = p.split(":");
        console.log(`  ${label}: ${value}`);
      }
    }

    if (addresses) {
      console.log("\nAddress:");
      for (const a of addresses.split(";").filter(Boolean)) {
        const [label, ...rest] = a.split(":");
        console.log(`  ${label}: ${rest.join(":")}`);
      }
    }

    if (birthday) {
      console.log(`\nBirthday: ${birthday}`);
    }

    if (note) {
      console.log("\nNotes:");
      console.log(note);
    }

    console.log("=".repeat(60) + "\n");
  },

  list(limit: number = 50): void {
    const script = `
      tell application "Contacts"
        set output to ""
        set counter to 0
        repeat with p in every person
          if counter >= ${limit} then exit repeat
          set pId to id of p
          set pName to name of p
          set pEmail to ""
          try
            set pEmail to value of first email of p
          end try
          set pCompany to ""
          try
            set pCompany to organization of p
          end try
          set output to output & pId & "|" & pName & "|" & pEmail & "|" & pCompany & "\\n"
          set counter to counter + 1
        end repeat
        return output
      end tell
    `;

    const result = runAppleScript(script);

    console.log(`\n Contacts (showing ${limit})\n`);
    console.log("-".repeat(60));

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("|");
      if (parts.length >= 4) {
        const [, name, email, company] = parts;
        const details = [email, company].filter(Boolean).join(" - ");
        console.log(`  ${name}${details ? ` (${details})` : ""}`);
      }
    }
    console.log("\n");
  },

  me(): void {
    const script = `
      tell application "Contacts"
        set myCard to my card
        if myCard is missing value then
          error "No 'My Card' set in Contacts"
        end if

        set pName to name of myCard
        set pEmails to ""
        repeat with e in emails of myCard
          set pEmails to pEmails & (label of e) & ":" & (value of e) & ","
        end repeat
        set pPhones to ""
        repeat with ph in phones of myCard
          set pPhones to pPhones & (label of ph) & ":" & (value of ph) & ","
        end repeat
        set pCompany to ""
        try
          set pCompany to organization of myCard
        end try
        set pTitle to ""
        try
          set pTitle to job title of myCard
        end try

        return pName & "|||" & pEmails & "|||" & pPhones & "|||" & pCompany & "|||" & pTitle
      end tell
    `;

    const result = runAppleScript(script);
    const [name, emails, phones, company, title] = result.split("|||");

    console.log("\n" + "=".repeat(50));
    console.log(` My Card: ${name}`);
    console.log("=".repeat(50));

    if (company || title) {
      const work = [title, company].filter(Boolean).join(" at ");
      console.log(`Work: ${work}`);
    }

    if (emails) {
      console.log("\nEmail:");
      for (const e of emails.split(",").filter(Boolean)) {
        const [label, value] = e.split(":");
        console.log(`  ${label}: ${value}`);
      }
    }

    if (phones) {
      console.log("\nPhone:");
      for (const p of phones.split(",").filter(Boolean)) {
        const [label, value] = p.split(":");
        console.log(`  ${label}: ${value}`);
      }
    }

    console.log("=".repeat(50) + "\n");
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// REMINDERS SERVICE
// ══════════════════════════════════════════════════════════════════════════════

interface Reminder {
  id: string;
  name: string;
  dueDate: string;
  completed: boolean;
  priority: number;
  notes: string;
}

const reminders = {
  lists(): void {
    const script = `
      tell application "Reminders"
        set output to ""
        repeat with lst in lists
          set lstName to name of lst
          set lstCount to count of (reminders of lst whose completed is false)
          set output to output & lstName & "|" & lstCount & "\\n"
        end repeat
        return output
      end tell
    `;

    const result = runAppleScript(script);

    console.log("\n Reminder Lists\n");
    console.log("-".repeat(50));

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const [name, count] = line.split("|");
      const countNum = parseInt(count, 10) || 0;
      const badge = countNum > 0 ? ` (${countNum})` : "";
      console.log(`   ${name}${badge}`);
    }
    console.log("\n");
  },

  show(listName: string, showCompleted: boolean = false): void {
    const listSafe = escapeAS(listName);
    const filter = showCompleted ? "" : "whose completed is false";

    const script = `
      tell application "Reminders"
        set theList to list "${listSafe}"
        set output to ""
        set idx to 1
        repeat with r in (reminders of theList ${filter})
          set rId to id of r
          set rName to name of r
          set rDue to ""
          try
            set rDue to due date of r as text
          end try
          set rCompleted to completed of r
          set rPriority to priority of r
          set rNotes to ""
          try
            set rNotes to body of r
          end try
          set output to output & idx & "|" & rId & "|" & rName & "|" & rDue & "|" & rCompleted & "|" & rPriority & "|" & rNotes & "\\n"
          set idx to idx + 1
        end repeat
        return output
      end tell
    `;

    const result = runAppleScript(script, 120000); // 2 min timeout
    const remindersList: (Reminder & { index: number })[] = [];

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("|");
      if (parts.length >= 7) {
        remindersList.push({
          index: parseInt(parts[0], 10),
          id: parts[1],
          name: parts[2],
          dueDate: parts[3],
          completed: parts[4].toLowerCase() === "true",
          priority: parseInt(parts[5], 10) || 0,
          notes: parts[6],
        });
      }
    }

    console.log(`\n Reminders in "${listName}" (${remindersList.length})\n`);
    console.log("-".repeat(60));

    if (remindersList.length === 0) {
      console.log("\n  No reminders.\n");
      return;
    }

    for (const r of remindersList) {
      const checkbox = r.completed ? "[x]" : "[ ]";
      const priority = r.priority > 0 ? ` !${r.priority}` : "";
      const due = r.dueDate ? ` (${r.dueDate})` : "";
      console.log(`\n  ${r.index}. ${checkbox} ${r.name}${priority}${due}`);
      if (r.notes) {
        console.log(`      ${r.notes}`);
      }
    }
    console.log("\n");
  },

  add(
    listName: string,
    title: string,
    options: { due?: string; priority?: number; notes?: string }
  ): void {
    const listSafe = escapeAS(listName);
    const titleSafe = escapeAS(title);

    let props = `{name:"${titleSafe}"`;

    if (options.due) {
      const dueDate = parseDate(options.due);
      props += `, due date:date "${formatDateAS(dueDate)}"`;
    }

    if (options.priority) {
      props += `, priority:${options.priority}`;
    }

    if (options.notes) {
      props += `, body:"${escapeAS(options.notes)}"`;
    }

    props += "}";

    const script = `
      tell application "Reminders"
        tell list "${listSafe}"
          set newReminder to make new reminder with properties ${props}
          return name of newReminder
        end tell
      end tell
    `;

    const result = runAppleScript(script);

    console.log("\n Reminder added!");
    console.log(`   List: ${listName}`);
    console.log(`   Title: ${result}`);
    if (options.due) {
      console.log(`   Due: ${options.due}`);
    }
    console.log("\n");
  },

  complete(listName: string, index: number): void {
    const listSafe = escapeAS(listName);

    const script = `
      tell application "Reminders"
        set theList to list "${listSafe}"
        set incompleteReminders to (reminders of theList whose completed is false)
        if ${index} > (count of incompleteReminders) then
          error "Reminder index out of range"
        end if
        set r to item ${index} of incompleteReminders
        set completed of r to true
        return name of r
      end tell
    `;

    const result = runAppleScript(script);
    console.log(`\n Completed: ${result}\n`);
  },

  delete(listName: string, index: number): void {
    const listSafe = escapeAS(listName);

    const script = `
      tell application "Reminders"
        set theList to list "${listSafe}"
        set incompleteReminders to (reminders of theList whose completed is false)
        if ${index} > (count of incompleteReminders) then
          error "Reminder index out of range"
        end if
        set r to item ${index} of incompleteReminders
        set rName to name of r
        delete r
        return rName
      end tell
    `;

    const result = runAppleScript(script);
    console.log(`\n Deleted: ${result}\n`);
  },

  today(): void {
    const script = `
      tell application "Reminders"
        set todayStart to current date
        set time of todayStart to 0
        set todayEnd to todayStart + 1 * days

        set output to ""
        repeat with lst in lists
          set lstName to name of lst
          repeat with r in (reminders of lst whose completed is false)
            try
              set rDue to due date of r
              if rDue >= todayStart and rDue < todayEnd then
                set rName to name of r
                set rPriority to priority of r
                set output to output & lstName & "|" & rName & "|" & rDue & "|" & rPriority & "\\n"
              end if
            end try
          end repeat
        end repeat
        return output
      end tell
    `;

    const result = runAppleScript(script, 120000); // 2 min timeout

    console.log("\n Due Today\n");
    console.log("-".repeat(50));

    if (!result.trim()) {
      console.log("\n  Nothing due today!\n");
      return;
    }

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const [list, name, due, priority] = line.split("|");
      const priorityStr = parseInt(priority) > 0 ? ` !${priority}` : "";
      console.log(`\n  [ ] ${name}${priorityStr}`);
      console.log(`      [${list}]`);
    }
    console.log("\n");
  },

  overdue(): void {
    const script = `
      tell application "Reminders"
        set now to current date

        set output to ""
        repeat with lst in lists
          set lstName to name of lst
          repeat with r in (reminders of lst whose completed is false)
            try
              set rDue to due date of r
              if rDue < now then
                set rName to name of r
                set rPriority to priority of r
                set output to output & lstName & "|" & rName & "|" & rDue & "|" & rPriority & "\\n"
              end if
            end try
          end repeat
        end repeat
        return output
      end tell
    `;

    const result = runAppleScript(script, 120000); // 2 min timeout

    console.log("\n Overdue\n");
    console.log("-".repeat(50));

    if (!result.trim()) {
      console.log("\n  Nothing overdue!\n");
      return;
    }

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const [list, name, due, priority] = line.split("|");
      const priorityStr = parseInt(priority) > 0 ? ` !${priority}` : "";
      const dueDate = new Date(due);
      const dueStr = dueDate.toLocaleDateString();
      console.log(`\n  [ ] ${name}${priorityStr}`);
      console.log(`      Due: ${dueStr} [${list}]`);
    }
    console.log("\n");
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// NOTES SERVICE
// ══════════════════════════════════════════════════════════════════════════════

interface Note {
  id: string;
  name: string;
  folder: string;
  creationDate: string;
  modificationDate: string;
}

const notes = {
  folders(): void {
    const script = `
      tell application "Notes"
        set output to ""
        repeat with f in folders
          set fName to name of f
          set fCount to count of notes of f
          set output to output & fName & "|" & fCount & "\\n"
        end repeat
        return output
      end tell
    `;

    const result = runAppleScript(script);

    console.log("\n Note Folders\n");
    console.log("-".repeat(50));

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const [name, count] = line.split("|");
      console.log(`   ${name} (${count})`);
    }
    console.log("\n");
  },

  list(options: { folder?: string; limit?: number }): void {
    const limit = options.limit || 20;
    const folderFilter = options.folder ? `of folder "${escapeAS(options.folder)}"` : "";

    const script = `
      tell application "Notes"
        set output to ""
        set counter to 0
        repeat with n in (notes ${folderFilter})
          if counter >= ${limit} then exit repeat
          try
            set nId to id of n
            set nName to name of n
            set nFolder to ""
            try
              set nFolder to name of container of n
            end try
            set nCreated to creation date of n as text
            set nModified to modification date of n as text
            set output to output & nId & "|" & nName & "|" & nFolder & "|" & nCreated & "|" & nModified & "\\n"
            set counter to counter + 1
          end try
        end repeat
        return output
      end tell
    `;

    const result = runAppleScript(script);
    const notesList: Note[] = [];

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("|");
      if (parts.length >= 5) {
        notesList.push({
          id: parts[0],
          name: parts[1],
          folder: parts[2],
          creationDate: parts[3],
          modificationDate: parts[4],
        });
      }
    }

    const header = options.folder ? `Notes in "${options.folder}"` : "Recent Notes";
    console.log(`\n ${header} (${notesList.length})\n`);
    console.log("-".repeat(60));

    if (notesList.length === 0) {
      console.log("\n  No notes found.\n");
      return;
    }

    for (const n of notesList) {
      const modified = new Date(n.modificationDate);
      const modStr = modified.toLocaleDateString();
      console.log(`\n  ${n.name}`);
      console.log(`    [${n.folder}] - Modified: ${modStr}`);
    }
    console.log("\n");
  },

  show(title: string): void {
    const titleSafe = escapeAS(title);

    const script = `
      tell application "Notes"
        set matchedNotes to (notes whose name contains "${titleSafe}")
        if (count of matchedNotes) is 0 then
          error "Note not found"
        end if

        set n to first item of matchedNotes
        set nName to name of n
        set nBody to plaintext of n
        set nFolder to ""
        try
          set nFolder to name of container of n
        end try
        set nCreated to creation date of n as text
        set nModified to modification date of n as text

        return nName & "|||" & nBody & "|||" & nFolder & "|||" & nCreated & "|||" & nModified
      end tell
    `;

    const result = runAppleScript(script);
    const [name, body, folder, created, modified] = result.split("|||");

    console.log("\n" + "=".repeat(60));
    console.log(` ${name}`);
    console.log("=".repeat(60));
    console.log(`Folder: ${folder}`);
    console.log(`Created: ${created}`);
    console.log(`Modified: ${modified}`);
    console.log("-".repeat(60));
    console.log(body);
    console.log("=".repeat(60) + "\n");
  },

  search(query: string): void {
    const querySafe = escapeAS(query);

    const script = `
      tell application "Notes"
        set output to ""
        repeat with n in notes
          try
            set nName to name of n
            set nBody to plaintext of n
            if nName contains "${querySafe}" or nBody contains "${querySafe}" then
              set nId to id of n
              set nFolder to ""
              try
                set nFolder to name of container of n
              end try
              set nModified to modification date of n as text
              -- Get snippet
              set snippet to ""
              if nBody contains "${querySafe}" then
                set snippet to text 1 thru (min of {100, length of nBody}) of nBody
              end if
              set output to output & nId & "|" & nName & "|" & nFolder & "|" & nModified & "|" & snippet & "\\n"
            end if
          end try
        end repeat
        return output
      end tell
    `;

    const result = runAppleScript(script, 120000); // 2 min timeout for search

    console.log(`\n Search results for "${query}"\n`);
    console.log("-".repeat(60));

    if (!result.trim()) {
      console.log("\n  No notes found.\n");
      return;
    }

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("|");
      if (parts.length >= 4) {
        const [, name, folder, modified, snippet] = parts;
        console.log(`\n  ${name}`);
        console.log(`    [${folder}]`);
        if (snippet) {
          console.log(`    "${snippet.slice(0, 80)}..."`);
        }
      }
    }
    console.log("\n");
  },

  add(title: string, body: string, folder?: string): void {
    const titleSafe = escapeAS(title);
    const bodySafe = escapeAS(body);
    const folderTarget = folder ? `folder "${escapeAS(folder)}"` : `default folder`;

    const script = `
      tell application "Notes"
        tell ${folderTarget}
          set newNote to make new note with properties {name:"${titleSafe}", body:"${bodySafe}"}
          return name of newNote
        end tell
      end tell
    `;

    const result = runAppleScript(script);

    console.log("\n Note created!");
    console.log(`   Title: ${result}`);
    if (folder) {
      console.log(`   Folder: ${folder}`);
    }
    console.log("\n");
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// MAIN ROUTER & HELP
// ══════════════════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const service = args[0];
const command = args[1];

function getArg(flag: string, alias?: string): string | undefined {
  const idx = args.indexOf(flag);
  const aliasIdx = alias ? args.indexOf(alias) : -1;
  const foundIdx = idx !== -1 ? idx : aliasIdx;
  if (foundIdx !== -1 && args[foundIdx + 1]) {
    return args[foundIdx + 1];
  }
  return undefined;
}

function getAllArgs(flag: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) {
      results.push(args[i + 1]);
    }
  }
  return results;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

function printHelp(): void {
  console.log(`
mac - Unified CLI for macOS services

USAGE:
  mac <service> <command> [options]

SERVICES:
  mail        Email operations (Apple Mail)
  calendar    Calendar events
  contacts    Contact lookup
  reminders   Reminders/tasks
  notes       Notes access

MAIL COMMANDS:
  mac mail accounts                          List all mail accounts
  mac mail mailboxes <account>               List mailboxes for an account
  mac mail search <account> [options]        Search messages
    --mailbox <name>    Mailbox to search (default: INBOX)
    --sender <text>     Filter by sender
    --subject <text>    Filter by subject
    --unread            Only show unread messages
    --limit <n>         Limit results (default: 20)
  mac mail read <message-id>                 Read a specific message
  mac mail attachments <message-id>          List attachments
  mac mail save-attachments <id> [dir]       Save attachments
  mac mail draft <to> -s <subj> -b <body>    Create draft
    --cc <email>        CC recipient
    --bcc <email>       BCC recipient
  mac mail send <to> -s <subj> -b <body>     Send email (with confirmation)
    --no-confirm        Skip confirmation dialog
  mac mail mark-read <id>...                 Mark as read
  mac mail mark-unread <id>...               Mark as unread

CALENDAR COMMANDS:
  mac calendar calendars                     List all calendars
  mac calendar list [--days N]               Upcoming events (default: 7 days)
  mac calendar today                         Today's events
  mac calendar tomorrow                      Tomorrow's events
  mac calendar show <event-id>               Event details
  mac calendar add <title> [options]         Create event
    --date <date>       Date (e.g., "tomorrow", "2026-01-20")
    --time <HH:MM>      Time (e.g., "14:30")
    --duration <mins>   Duration in minutes (default: 60)
    --calendar <name>   Calendar name
    --location <text>   Location
    --notes <text>      Notes/description
    --all-day           Create all-day event
  mac calendar delete <event-id>             Delete event

CONTACTS COMMANDS:
  mac contacts search <query>                Search by name
  mac contacts show <name>                   Show contact details
  mac contacts list [--limit N]              List contacts (default: 50)
  mac contacts me                            Show "my card" info

REMINDERS COMMANDS:
  mac reminders lists                        List all reminder lists
  mac reminders show <list>                  Show reminders in a list
    --completed         Include completed reminders
  mac reminders add <list> <title> [options] Add a reminder
    --due <date>        Due date (e.g., "tomorrow")
    --priority <1-3>    Priority level
    --notes <text>      Notes
  mac reminders complete <list> <index>      Mark as complete
  mac reminders delete <list> <index>        Delete reminder
  mac reminders today                        Due today across all lists
  mac reminders overdue                      Overdue items

NOTES COMMANDS:
  mac notes folders                          List all folders
  mac notes list [options]                   List notes
    --folder <name>     Filter by folder
    --limit <n>         Limit results (default: 20)
  mac notes show <title>                     Show note content
  mac notes search <query>                   Search note content
  mac notes add <title> --body <text> [--folder <name>]  Create note

EXAMPLES:
  mac mail accounts
  mac mail search "Google" --unread --limit 5
  mac calendar today
  mac calendar add "Team Meeting" --date tomorrow --time 14:00 --duration 60
  mac contacts search "John"
  mac reminders show "Shopping"
  mac reminders add "Work" "Review PR" --due tomorrow --priority 1
  mac notes search "project ideas"
`);
}

try {
  if (!service || service === "help" || service === "--help" || service === "-h") {
    printHelp();
    process.exit(0);
  }

  switch (service) {
    // ── MAIL ───────────────────────────────────────────────────────────────────
    case "mail":
      switch (command) {
        case "accounts":
          mail.accounts();
          break;

        case "mailboxes": {
          const account = args[2];
          if (!account) {
            console.error("Usage: mac mail mailboxes <account>");
            process.exit(1);
          }
          mail.mailboxes(account);
          break;
        }

        case "search": {
          const account = args[2];
          if (!account) {
            console.error("Usage: mac mail search <account> [options]");
            process.exit(1);
          }
          mail.search(account, getArg("--mailbox") || "INBOX", {
            sender: getArg("--sender"),
            subject: getArg("--subject"),
            unread: hasFlag("--unread"),
            limit: getArg("--limit") ? parseInt(getArg("--limit")!, 10) : 20,
          });
          break;
        }

        case "read": {
          const messageId = args[2];
          if (!messageId) {
            console.error("Usage: mac mail read <message-id>");
            process.exit(1);
          }
          mail.read(messageId);
          break;
        }

        case "attachments": {
          const messageId = args[2];
          if (!messageId) {
            console.error("Usage: mac mail attachments <message-id>");
            process.exit(1);
          }
          mail.attachments(messageId);
          break;
        }

        case "save-attachments": {
          const messageId = args[2];
          const saveDir = args[3];
          if (!messageId) {
            console.error("Usage: mac mail save-attachments <message-id> [directory]");
            process.exit(1);
          }
          mail.saveAttachments(messageId, saveDir);
          break;
        }

        case "draft": {
          const to = args[2];
          const subject = getArg("-s") || getArg("--subject");
          const body = getArg("-b") || getArg("--body");

          if (!to || !subject || !body) {
            console.error("Usage: mac mail draft <to> -s <subject> -b <body>");
            process.exit(1);
          }

          mail.draft(to.split(","), subject, body, {
            cc: getAllArgs("--cc"),
            bcc: getAllArgs("--bcc"),
          });
          break;
        }

        case "send": {
          const to = args[2];
          const subject = getArg("-s") || getArg("--subject");
          const body = getArg("-b") || getArg("--body");

          if (!to || !subject || !body) {
            console.error("Usage: mac mail send <to> -s <subject> -b <body>");
            process.exit(1);
          }

          mail.send(to.split(","), subject, body, {
            cc: getAllArgs("--cc"),
            bcc: getAllArgs("--bcc"),
            confirm: !hasFlag("--no-confirm"),
          });
          break;
        }

        case "mark-read": {
          const ids = args.slice(2);
          if (ids.length === 0) {
            console.error("Usage: mac mail mark-read <id> [id...]");
            process.exit(1);
          }
          mail.markRead(ids);
          break;
        }

        case "mark-unread": {
          const ids = args.slice(2);
          if (ids.length === 0) {
            console.error("Usage: mac mail mark-unread <id> [id...]");
            process.exit(1);
          }
          mail.markUnread(ids);
          break;
        }

        default:
          console.error(`Unknown mail command: ${command}`);
          console.error("Run 'mac mail help' for usage");
          process.exit(1);
      }
      break;

    // ── CALENDAR ───────────────────────────────────────────────────────────────
    case "calendar":
      switch (command) {
        case "calendars":
          calendar.calendars();
          break;

        case "list": {
          const days = getArg("--days") ? parseInt(getArg("--days")!, 10) : 7;
          calendar.list(days);
          break;
        }

        case "today":
          calendar.today();
          break;

        case "tomorrow":
          calendar.tomorrow();
          break;

        case "show": {
          const eventId = args[2];
          if (!eventId) {
            console.error("Usage: mac calendar show <event-id>");
            process.exit(1);
          }
          calendar.show(eventId);
          break;
        }

        case "add": {
          const title = args[2];
          if (!title) {
            console.error("Usage: mac calendar add <title> [options]");
            process.exit(1);
          }
          calendar.add(title, {
            date: getArg("--date"),
            time: getArg("--time"),
            duration: getArg("--duration") ? parseInt(getArg("--duration")!, 10) : undefined,
            calendar: getArg("--calendar"),
            location: getArg("--location"),
            notes: getArg("--notes"),
            allDay: hasFlag("--all-day"),
          });
          break;
        }

        case "delete": {
          const eventId = args[2];
          if (!eventId) {
            console.error("Usage: mac calendar delete <event-id>");
            process.exit(1);
          }
          calendar.delete(eventId);
          break;
        }

        default:
          console.error(`Unknown calendar command: ${command}`);
          console.error("Run 'mac help' for usage");
          process.exit(1);
      }
      break;

    // ── CONTACTS ───────────────────────────────────────────────────────────────
    case "contacts":
      switch (command) {
        case "search": {
          const query = args[2];
          if (!query) {
            console.error("Usage: mac contacts search <query>");
            process.exit(1);
          }
          contacts.search(query);
          break;
        }

        case "show": {
          const name = args[2];
          if (!name) {
            console.error("Usage: mac contacts show <name>");
            process.exit(1);
          }
          contacts.show(name);
          break;
        }

        case "list": {
          const limit = getArg("--limit") ? parseInt(getArg("--limit")!, 10) : 50;
          contacts.list(limit);
          break;
        }

        case "me":
          contacts.me();
          break;

        default:
          console.error(`Unknown contacts command: ${command}`);
          console.error("Run 'mac help' for usage");
          process.exit(1);
      }
      break;

    // ── REMINDERS ──────────────────────────────────────────────────────────────
    case "reminders":
      switch (command) {
        case "lists":
          reminders.lists();
          break;

        case "show": {
          const listName = args[2];
          if (!listName) {
            console.error("Usage: mac reminders show <list>");
            process.exit(1);
          }
          reminders.show(listName, hasFlag("--completed"));
          break;
        }

        case "add": {
          const listName = args[2];
          const title = args[3];
          if (!listName || !title) {
            console.error("Usage: mac reminders add <list> <title> [options]");
            process.exit(1);
          }
          reminders.add(listName, title, {
            due: getArg("--due"),
            priority: getArg("--priority") ? parseInt(getArg("--priority")!, 10) : undefined,
            notes: getArg("--notes"),
          });
          break;
        }

        case "complete": {
          const listName = args[2];
          const index = args[3];
          if (!listName || !index) {
            console.error("Usage: mac reminders complete <list> <index>");
            process.exit(1);
          }
          reminders.complete(listName, parseInt(index, 10));
          break;
        }

        case "delete": {
          const listName = args[2];
          const index = args[3];
          if (!listName || !index) {
            console.error("Usage: mac reminders delete <list> <index>");
            process.exit(1);
          }
          reminders.delete(listName, parseInt(index, 10));
          break;
        }

        case "today":
          reminders.today();
          break;

        case "overdue":
          reminders.overdue();
          break;

        default:
          console.error(`Unknown reminders command: ${command}`);
          console.error("Run 'mac help' for usage");
          process.exit(1);
      }
      break;

    // ── NOTES ──────────────────────────────────────────────────────────────────
    case "notes":
      switch (command) {
        case "folders":
          notes.folders();
          break;

        case "list":
          notes.list({
            folder: getArg("--folder"),
            limit: getArg("--limit") ? parseInt(getArg("--limit")!, 10) : 20,
          });
          break;

        case "show": {
          const title = args[2];
          if (!title) {
            console.error("Usage: mac notes show <title>");
            process.exit(1);
          }
          notes.show(title);
          break;
        }

        case "search": {
          const query = args[2];
          if (!query) {
            console.error("Usage: mac notes search <query>");
            process.exit(1);
          }
          notes.search(query);
          break;
        }

        case "add": {
          const title = args[2];
          const body = getArg("--body");
          if (!title || !body) {
            console.error("Usage: mac notes add <title> --body <text> [--folder <name>]");
            process.exit(1);
          }
          notes.add(title, body, getArg("--folder"));
          break;
        }

        default:
          console.error(`Unknown notes command: ${command}`);
          console.error("Run 'mac help' for usage");
          process.exit(1);
      }
      break;

    default:
      console.error(`Unknown service: ${service}`);
      printHelp();
      process.exit(1);
  }
} catch (error: any) {
  console.error(`\n Error: ${error.message}\n`);
  process.exit(1);
}
