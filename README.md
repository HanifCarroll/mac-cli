# mac-cli

Unified CLI for macOS services: Mail, Calendar, Contacts, Reminders, and Notes.

Built with [Bun](https://bun.sh) and AppleScript for native macOS integration.

## How It Works

This CLI uses AppleScript to communicate directly with macOS apps (Mail, Calendar, Contacts, Reminders, Notes). When you run a command:

1. **Command parsing** - Bun parses the CLI arguments and routes to the appropriate service
2. **AppleScript generation** - The CLI builds an AppleScript command specific to your request
3. **Native execution** - The script runs via `osascript`, which talks directly to the macOS app
4. **Response parsing** - Results are parsed from AppleScript's output format into structured data
5. **Display** - Data is formatted and printed to the terminal

This approach means:
- **No API keys or authentication** - Uses your existing macOS app data
- **Works offline** - Everything runs locally
- **Real-time sync** - Changes appear immediately in the native apps
- **Privacy** - Data never leaves your machine

## Installation

### Prerequisites

- macOS (uses native AppleScript)
- [Bun](https://bun.sh) runtime

### Install

```bash
# Clone the repo
git clone https://github.com/hanifcarroll/mac-cli.git
cd mac-cli

# Make executable and link globally
chmod +x mac.ts
bun link

# Or copy directly to your PATH
cp mac.ts ~/.local/bin/mac
chmod +x ~/.local/bin/mac
```

## Usage

```bash
mac <service> <command> [options]
```

### Services

- `mail` - Email operations (Apple Mail)
- `calendar` - Calendar events
- `contacts` - Contact lookup
- `reminders` - Reminders/tasks
- `notes` - Notes access

## Commands

### Mail

```bash
mac mail accounts                          # List all mail accounts
mac mail mailboxes <account>               # List mailboxes for an account
mac mail search <account> [options]        # Search messages
  --mailbox <name>    Mailbox to search (default: INBOX)
  --sender <text>     Filter by sender
  --subject <text>    Filter by subject
  --unread            Only show unread messages
  --limit <n>         Limit results (default: 20)
mac mail read <message-id>                 # Read a specific message
mac mail attachments <message-id>          # List attachments
mac mail save-attachments <id> [dir]       # Save attachments
mac mail draft <to> -s <subj> -b <body>    # Create draft
  --cc <email>        CC recipient
  --bcc <email>       BCC recipient
mac mail send <to> -s <subj> -b <body>     # Send email (with confirmation)
  --no-confirm        Skip confirmation dialog
mac mail mark-read <id>...                 # Mark as read
mac mail mark-unread <id>...               # Mark as unread
```

### Calendar

```bash
mac calendar calendars                     # List all calendars
mac calendar list [--days N]               # Upcoming events (default: 7 days)
mac calendar today                         # Today's events
mac calendar tomorrow                      # Tomorrow's events
mac calendar show <event-id>               # Event details
mac calendar add <title> [options]         # Create event
  --date <date>       Date (e.g., "tomorrow", "2026-01-20")
  --time <HH:MM>      Time (e.g., "14:30")
  --duration <mins>   Duration in minutes (default: 60)
  --calendar <name>   Calendar name
  --location <text>   Location
  --notes <text>      Notes/description
  --all-day           Create all-day event
mac calendar delete <event-id>             # Delete event
```

### Contacts

```bash
mac contacts search <query>                # Search by name
mac contacts show <name>                   # Show contact details
mac contacts list [--limit N]              # List contacts (default: 50)
mac contacts me                            # Show "my card" info
```

### Reminders

```bash
mac reminders lists                        # List all reminder lists
mac reminders show <list>                  # Show reminders in a list
  --completed         Include completed reminders
mac reminders add <list> <title> [options] # Add a reminder
  --due <date>        Due date (e.g., "tomorrow")
  --priority <1-3>    Priority level
  --notes <text>      Notes
mac reminders complete <list> <index>      # Mark as complete
mac reminders delete <list> <index>        # Delete reminder
mac reminders today                        # Due today across all lists
mac reminders overdue                      # Overdue items
```

### Notes

```bash
mac notes folders                          # List all folders
mac notes list [options]                   # List notes
  --folder <name>     Filter by folder
  --limit <n>         Limit results (default: 20)
mac notes show <title>                     # Show note content
mac notes search <query>                   # Search note content
mac notes add <title> --body <text> [--folder <name>]  # Create note
```

## Examples

```bash
# Check unread emails
mac mail search "Gmail" --unread --limit 5

# See today's schedule
mac calendar today

# Find a contact
mac contacts search "John"

# Add a reminder
mac reminders add "Shopping" "Buy milk" --due tomorrow

# Search notes
mac notes search "meeting notes"
```

## Date Formats

The CLI accepts natural language dates:

- `today`, `tomorrow`, `yesterday`
- `next monday`, `next friday`, etc.
- `in 3 days`, `in 1 week`
- ISO format: `2026-01-20`

## License

MIT
