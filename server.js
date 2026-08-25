const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const compression = require('compression');

const app = express();
const server = http.createServer(app);

// Render.com (και οι περισσότερες PaaS) βρίσκονται πίσω από reverse proxy·
// αυτό εξασφαλίζει σωστό req.ip/req.secure αν χρειαστεί στο μέλλον.
app.set('trust proxy', 1);

// Συμπίεση απαντήσεων (gzip) -> πιο γρήγορη φόρτωση σε κινητά δίκτυα.
app.use(compression());

// Βασικά security headers (δεν επηρεάζουν λειτουργικότητα/CDN).
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
    next();
});

// === ΣΤΑΤΙΚΑ ΑΡΧΕΙΑ & PATHS ===
// Το index.html σερβίρεται πάντα φρέσκο (no-cache) ώστε οι παίκτες να
// παίρνουν αμέσως νέες εκδόσεις μετά από deploy· τα υπόλοιπα static assets
// (CSS/JS/εικόνες) μπορούν να κάνουν cache για ταχύτητα σε κινητά.
app.use(express.static(path.join(__dirname, 'public'), {
    index: false,
    maxAge: '1h'
}));

app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/ping', (req, res) => {
    res.send('pong');
});

app.get('/healthz', (req, res) => {
    res.json({ status: 'ok', players: globalGameInstance ? globalGameInstance.playerOrder.length : 0 });
});

// === ΣΤΑΘΕΡΕΣ ΠΑΙΧΝΙΔΙΟΥ ===
const TURN_TIME_MS = 60000;
const LOBBY_IDLE_MS = 120000;
const ROUND_RESTART_MS = 4000;
const DEAL_INTERVAL_MS = 50;
const STARTING_HAND_SIZE = 11;
const MAX_SCORE = 500;
const MAX_NAME_LEN = 15;
const MAX_CHAT_LEN = 80;

const SUITS = ['♠', '♣', '♥', '♦'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const io = new Server(server, {
    cors: { origin: process.env.CORS_ORIGIN || "*", methods: ["GET", "POST"] },
    pingInterval: 25000,
    pingTimeout: 60000
});

// Ελάχιστο διάστημα (ms) ανάμεσα σε ενέργειες παιχνιδιού από τον ίδιο socket.
// Ο επίσημος client ήδη εμποδίζει το spam (actionLocked/CLICK_DELAY)· αυτό
// είναι απλά ένα δεύτερο δίχτυ ασφαλείας ενάντια σε τροποποιημένο client,
// χωρίς να επηρεάζει καθόλου την κανονική εμπειρία παιχνιδιού.
const MIN_ACTION_INTERVAL_MS = 40;

function isThrottled(socket, eventName) {
    if (!socket._lastAction) socket._lastAction = {};
    const now = Date.now();
    const last = socket._lastAction[eventName] || 0;
    if (now - last < MIN_ACTION_INTERVAL_MS) return true;
    socket._lastAction[eventName] = now;
    return false;
}

class Game {
    constructor() {
        this.deck = [];
        this.discardPile = [];
        this.discardCount = 0;
        this.players = {};
        this.playerOrder = [];
        this.gameStarted = false;
        this.starting = false;
        this.roundHistory = [];
        this.roundStarterIndex = 0;
        this.timers = { lobby: null, deal: null, turn: null, restart: null };
        this.resetRoundState();
    }

    resetRoundState() {
        this.penaltyStack = 0;
        this.penaltyType = null;
        this.activeSuit = null;
        this.consecutiveTwos = 0;
        this.direction = 1;
        this.turnIndex = 0;
    }

    clearAllTimers() {
        Object.values(this.timers).forEach(t => {
            if (t) {
                clearTimeout(t);
                clearInterval(t);
            }
        });
        this.timers = { lobby: null, deal: null, turn: null, restart: null };
    }

    resetToLobby() {
        this.clearAllTimers();

        // ΕΠΙΘΕΤΙΚΟ ΚΑΘΑΡΙΣΜΑ RAM (Garbage Collection)
        this.deck.length = 0;
        this.discardPile.length = 0;
        this.roundHistory.length = 0;
        
        this.discardCount = 0;
        this.gameStarted = false;
        this.starting = false;
        this.roundStarterIndex = 0;
        this.resetRoundState();

        this.playerOrder = this.playerOrder.filter(id => this.players[id] && this.players[id].connected);

        Object.keys(this.players).forEach(id => {
            const p = this.players[id];
            if (!p || !p.connected) {
                delete this.players[id];
                return;
            }
            if (p.hand) p.hand.length = 0; // Καθαρισμός μνήμης χεριού
            p.totalScore = 0;
            p.hats = 0;
            p.hasDrawn = false;
            p.hasAtePenalty = false;
            p.lastChat = 0;
        });

        io.emit('playerCountUpdate', this.playerOrder.length);
    }

    forceEmergencyReset() {
        this.resetToLobby();
        io.emit('gameInterrupted', { message: '🚨 Κρίσιμο Σφάλμα! Επαναφορά...' });
        io.emit('notification', '🚨 Κρίσιμο Σφάλμα! Επαναφορά...');
        this.refreshLobbyTimer();
    }

    createDeck() {
        let newDeck = [];
        for (let i = 0; i < 2; i++) {
            SUITS.forEach(s => {
                VALUES.forEach(v => {
                    newDeck.push({
                        suit: s,
                        value: v,
                        color: (s === '♥' || s === '♦') ? 'red' : 'black'
                    });
                });
            });
        }
        return this.shuffle(newDeck);
    }

    shuffle(deck) {
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        return deck;
    }

    calculateHandScore(hand) {
        if (!hand || !Array.isArray(hand)) return 0;
        return hand.reduce((score, c) => {
            if (!c || !c.value) return score; // Προστασία από undefined κάρτες
            if (c.value === 'A') return score + 50;
            if (['K', 'Q', 'J', '10'].includes(c.value)) return score + 10;
            return score + (Number(c.value) || 0);
        }, 0);
    }

    resetLobby() {
        if (!this.gameStarted) {
            this.players = {};
            this.playerOrder.length = 0;
            this.deck.length = 0;
            this.discardPile.length = 0;
            this.discardCount = 0;
            this.roundHistory.length = 0;
            this.roundStarterIndex = 0;
            this.resetRoundState();

            io.emit('playerCountUpdate', 0);
            io.emit('notification', 'Το lobby μηδενίστηκε λόγω αδράνειας.');
        }
    }

    refreshLobbyTimer() {
        if (this.gameStarted) return;
        if (this.timers.lobby) clearTimeout(this.timers.lobby);
        this.timers.lobby = setTimeout(() => this.resetLobby(), LOBBY_IDLE_MS);
    }

    safeDraw(player) {
        if (!player || !player.hand) return false;

        if (this.deck.length === 0) {
            if (this.discardPile.length <= 1) return false;
            const topCard = this.discardPile.pop();
            this.deck = this.shuffle([...this.discardPile]);
            this.discardPile.length = 0; // Απελευθέρωση παλιάς στοίβας
            if (topCard) this.discardPile.push(topCard);
            io.emit('notification', '🔄 Ανακάτεμα τράπουλας!');
        }

        if (this.deck.length > 0) {
            player.hand.push(this.deck.pop());
            return true;
        }
        return false;
    }

    resetTurnTimer() {
        if (this.timers.turn) clearTimeout(this.timers.turn);
        if (!this.gameStarted || this.playerOrder.length === 0) return;
        
        this.timers.turn = setTimeout(() => {
            try {
                this.autoPlayTurn();
            } catch (e) {
                console.error("Σφάλμα στο autoPlayTurn:", e);
            }
        }, TURN_TIME_MS);
    }

    getNextActivePlayerIndex(startIndex, steps = 1) {
        const activeCount = this.playerOrder.filter(id => this.players[id] && this.players[id].connected).length;
        if (activeCount === 0) return 0;

        let idx = startIndex;
        const n = this.playerOrder.length;

        for (let i = 0; i < steps; i++) {
            let loopGuard = 0;
            do {
                idx = (idx + this.direction + n) % n;
                loopGuard++;
                if (loopGuard > n * 2) break; // Προστασία από Infinite Loop
            } while (!this.players[this.playerOrder[idx]] || !this.players[this.playerOrder[idx]].connected);
        }
        return idx;
    }

    getPreviousActivePlayerIndex(startIndex, steps = 1) {
        const activeCount = this.playerOrder.filter(id => this.players[id] && this.players[id].connected).length;
        if (activeCount === 0) return 0;

        let idx = startIndex;
        const n = this.playerOrder.length;

        for (let i = 0; i < steps; i++) {
            let loopGuard = 0;
            do {
                idx = (idx - this.direction + n) % n;
                loopGuard++;
                if (loopGuard > n * 2) break;
            } while (!this.players[this.playerOrder[idx]] || !this.players[this.playerOrder[idx]].connected);
        }
        return idx;
    }

    advanceTurn(steps) {
        if (this.playerOrder.length === 0) return;

        this.turnIndex = this.getNextActivePlayerIndex(this.turnIndex, steps);

        this.playerOrder.forEach(id => {
            if (this.players[id]) {
                this.players[id].hasDrawn = false;
                this.players[id].hasAtePenalty = false;
            }
        });

        this.resetTurnTimer();
    }

    autoPlayTurn() {
        if (!this.gameStarted || this.playerOrder.length === 0) return;

        const currentId = this.playerOrder[this.turnIndex];
        const p = this.players[currentId];

        if (!p || !p.connected) {
            this.advanceTurn(1);
            this.broadcastUpdate();
            return;
        }

        io.emit('notification', `Ο χρόνος έληξε! Auto-pass: ${p.name}`);

        if (this.penaltyStack > 0) {
            for (let i = 0; i < this.penaltyStack; i++) this.safeDraw(p);
            this.penaltyStack = 0;
            this.penaltyType = null;
            p.hasAtePenalty = true;
        } else if (!p.hasDrawn) {
            this.safeDraw(p);
            p.hasDrawn = true;
        }

        this.advanceTurn(1);
        this.broadcastUpdate();
    }

    joinGame(socket, data) {
        this.refreshLobbyTimer();

        let username = data?.username;
        let sessionId = data?.sessionId;

        if (sessionId != null) {
            sessionId = String(sessionId).trim().slice(0, 100);
            if (!sessionId) sessionId = null;
        } else {
            sessionId = null;
        }

        let cleanName = username
            ? String(username).replace(/[<>]/g, '').trim().substring(0, MAX_NAME_LEN)
            : "Παίκτης " + (this.playerOrder.length + 1);

        if (!cleanName) cleanName = "Παίκτης " + (this.playerOrder.length + 1);
        if (["δήμητρα", "δημητρα", "δημητρούλα"].includes(cleanName.toLowerCase())) cleanName += " ❤️";

        const existingId = Object.keys(this.players).find(id => this.players[id].sessionId === sessionId && sessionId != null);

        if (existingId) {
            if (existingId === socket.id) {
                this.players[socket.id].connected = true;
                socket.emit('rejoinSuccess', {
                    gameStarted: this.gameStarted,
                    myHand: this.players[socket.id].hand,
                    history: this.roundHistory,
                    players: this.playerOrder.map(id => this.players[id]).filter(Boolean)
                });
                if (this.gameStarted) this.broadcastUpdate();
                else io.emit('playerCountUpdate', this.playerOrder.length);
                return;
            }

            this.players[socket.id] = this.players[existingId];
            this.players[socket.id].id = socket.id;
            this.players[socket.id].connected = true;

            const idx = this.playerOrder.indexOf(existingId);
            if (idx !== -1) this.playerOrder[idx] = socket.id;

            delete this.players[existingId];

            socket.emit('rejoinSuccess', {
                gameStarted: this.gameStarted,
                myHand: this.players[socket.id].hand,
                history: this.roundHistory,
                players: this.playerOrder.map(id => this.players[id]).filter(Boolean)
            });

            io.emit('playerCountUpdate', this.playerOrder.length);
            if (this.gameStarted) this.broadcastUpdate();
            return;
        }

        if (this.gameStarted) {
            return socket.emit('notification', 'Το παιχνίδι έχει ήδη ξεκινήσει!');
        }

        this.players[socket.id] = {
            id: socket.id,
            sessionId,
            hand: [],
            name: cleanName,
            totalScore: 0,
            hats: 0,
            hasDrawn: false,
            hasAtePenalty: false,
            connected: true,
            lastChat: 0
        };

        this.playerOrder.push(socket.id);
        io.emit('playerCountUpdate', this.playerOrder.length);
        socket.emit('joinedLobby');
    }

    playCard(socket, data) {
        this.refreshLobbyTimer();
        const p = this.players[socket.id];

        if (!data || typeof data !== 'object') return socket.emit('actionRejected');
        if (!this.gameStarted || this.playerOrder[this.turnIndex] !== socket.id || !p) return socket.emit('actionRejected');
        if (!Number.isInteger(data.index) || data.index < 0 || data.index >= p.hand.length) return socket.emit('actionRejected');
        if (data.declaredSuit && !SUITS.includes(data.declaredSuit)) return socket.emit('actionRejected');

        const card = p.hand[data.index];
        const topCard = this.discardPile[this.discardPile.length - 1];
        
        if (!card || !topCard) return socket.emit('invalidMove');

        const top2 = this.discardPile.length >= 2 ? this.discardPile[this.discardPile.length - 2] : null;
        const effectiveSuit = this.activeSuit || topCard.suit;
        let isValid = false;

        if (this.penaltyStack > 0) {
            if (this.penaltyType === '7' && card.value === '7') isValid = true;
            if (this.penaltyType === 'J' && card.value === 'J') isValid = true;
        } else {
            // === ΔΙΟΡΘΩΣΗ ΓΙΑ ΑΣΣΟ ΣΕ ΑΣΣΟ ===
            if (card.value === 'A') {
                if (topCard && topCard.value === 'A') {
                    if (card.suit === effectiveSuit) isValid = true;
                } else {
                    isValid = true;
                }
            }
            else if (card.value === topCard.value || card.suit === effectiveSuit) isValid = true;
            else if (card.value === 'J' && card.color === 'red' && topCard.value === 'J') isValid = true;
        }

        if (!isValid) return socket.emit('invalidMove');

        const isSpecial = ['7', '8', 'J', 'A'].includes(card.value);

        if (!isSpecial && topCard) {
            if (card.value === topCard.value && card.suit === topCard.suit) {
                io.emit('notification', `${p.name}: Copy paste! 👯`);
            } else if (
                top2 && topCard.value === top2.value && topCard.suit === top2.suit &&
                card.value === topCard.value && card.suit !== topCard.suit
            ) {
                io.emit('notification', `${p.name}: Copy erased! ❌`);
            }
        }

        if (card.value === 'A') {
            // === ΔΙΟΡΘΩΣΗ ΓΙΑ ΑΣΣΟ ΣΕ ΑΣΣΟ (ΜΟΝΟ ΣΑΝ ΦΥΛΛΟ) ===
            if (topCard && topCard.value === 'A') {
                this.activeSuit = null;
                io.emit('notification', `${p.name}: Σαν φύλλο!`);
            } else {
                this.activeSuit = data.declaredSuit || card.suit;
            }
        } else {
            this.activeSuit = null;
        }

        p.hand.splice(data.index, 1);
        this.discardPile.push(card);
        this.discardCount++;

        if (p.hand.length === 1) {
            io.emit('notification', `${p.name}: Μία μία μία μία! ⚠️`);
        }

        if (p.hand.length === 0) {
            if (card.value === '8') {
                this.safeDraw(p);
                io.emit('notification', `${p.name}: Έκλεισα με 8 και τραβάω αναγκαστικά φύλλο! 🃏`);
                this.processCardLogic(card, p);
                p.hasDrawn = true;
                this.broadcastUpdate();
                return;
            }

            let isPenaltyHandled = false;
            const nextVictim = this.playerOrder[this.getNextActivePlayerIndex(this.turnIndex, 1)];
            const prevVictim = this.playerOrder[this.getPreviousActivePlayerIndex(this.turnIndex, 1)];

            if (card.value === 'J' && card.color === 'black') {
                const totalPenalty = (this.penaltyType === 'J' ? this.penaltyStack : 0) + 10;
                for (let i = 0; i < totalPenalty; i++) this.safeDraw(this.players[nextVictim]);
                io.emit('notification', `${p.name}: Κλείσιμο με Μαύρο Βαλέ! +${totalPenalty} στον/στην ${this.players[nextVictim]?.name}!`);
                this.penaltyStack = 0;
                this.penaltyType = null;
                isPenaltyHandled = true;
            } else if (card.value === '7') {
                const totalPenalty = (this.penaltyType === '7' ? this.penaltyStack : 0) + 2;
                for (let i = 0; i < totalPenalty; i++) this.safeDraw(this.players[nextVictim]);
                io.emit('notification', `${p.name}: Κλείσιμο με 7! +${totalPenalty} στον/στην ${this.players[nextVictim]?.name}!`);
                this.penaltyStack = 0;
                this.penaltyType = null;
                isPenaltyHandled = true;
            } else if (card.value === '2') {
                this.safeDraw(this.players[prevVictim]);
                io.emit('notification', `${p.name}: Κλείσιμο με 2! +1 στον/στην ${this.players[prevVictim]?.name}!`);
                isPenaltyHandled = true;
            }

            if (this.timers.turn) clearTimeout(this.timers.turn);
            this.broadcastUpdate();
            
            this.timers.restart = setTimeout(() => {
                try {
                    this.handleRoundEnd(socket.id, card.value === 'A');
                } catch(e) { console.error("Σφάλμα στο τέλος γύρου:", e); }
            }, isPenaltyHandled ? 3000 : 1500);
            return;
        }

        this.processCardLogic(card, p);
        this.broadcastUpdate();
    }

    drawCard(socket) {
        this.refreshLobbyTimer();
        const p = this.players[socket.id];

        if (!this.gameStarted || this.playerOrder[this.turnIndex] !== socket.id || !p) return socket.emit('actionRejected');

        if (this.penaltyStack > 0) {
            for (let i = 0; i < this.penaltyStack; i++) this.safeDraw(p);
            this.penaltyStack = 0;
            this.penaltyType = null;
            p.hasAtePenalty = true;
            this.resetTurnTimer();
            this.broadcastUpdate();
            return;
        }

        if (p.hasDrawn) return socket.emit('notification', 'Έχεις ήδη τραβήξει φύλλο!');

        this.safeDraw(p);
        p.hasDrawn = true;
        this.resetTurnTimer();
        this.broadcastUpdate();
    }

    passTurn(socket) {
        this.refreshLobbyTimer();
        const p = this.players[socket.id];

        if (!this.gameStarted || this.playerOrder[this.turnIndex] !== socket.id || !p) return;
        if (this.penaltyStack > 0) return socket.emit('notification', 'Πρέπει να τραβήξεις τις κάρτες ποινής πρώτα!');
        if (!p.hasDrawn) return socket.emit('notification', 'Δεν μπορείς να πας πάσο αν δεν τραβήξεις φύλλο!');

        this.advanceTurn(1);
        this.broadcastUpdate();
    }

    processCardLogic(card, p) {
        if (!card) return;
        let advance = true;
        let steps = 1;
        const isStart = (!p || !p.id);

        if (card.value === '2') {
            this.consecutiveTwos++;
            if (!isStart) {
                let msg = `${p.name}: Πάρε μία! 🃏`;
                if (this.consecutiveTwos >= 3) {
                    msg += "\nΞες πώς πάνε αυτά! 😂";
                    this.consecutiveTwos = 0;
                }
                io.emit('notification', msg);
                const victimId = this.playerOrder[this.getPreviousActivePlayerIndex(this.turnIndex, 1)];
                this.safeDraw(this.players[victimId]);
            }
        } else {
            this.consecutiveTwos = 0;
        }

        if (card.value === '8') {
            advance = false;
            if (!isStart) p.hasDrawn = false;
        } else if (card.value === '7') {
            this.penaltyStack += 2;
            this.penaltyType = '7';
        } else if (card.value === 'J' && card.color === 'black') {
            this.penaltyStack += 10;
            this.penaltyType = 'J';
        } else if (card.value === 'J' && card.color === 'red') {
            this.penaltyStack = 0;
            this.penaltyType = null;
        } else if (card.value === '3') {
            if (this.playerOrder.length === 2) advance = false;
            else this.direction *= -1;
        } else if (card.value === '9') {
            steps = (this.playerOrder.length === 2) ? 0 : 2;
            advance = (this.playerOrder.length !== 2);
            if (!isStart) {
                if (this.playerOrder.length === 2) io.emit('notification', `${p.name}: Ξανά παίζω! 🍹`);
                else io.emit('notification', `${p.name}: Άραξε 🍹`);
            }
        }

        if (advance) this.advanceTurn(steps);
        else this.resetTurnTimer();
    }

    startNewRound(reset = false) {
        this.clearAllTimers();
        this.gameStarted = true;
        this.starting = false;
        
        // Καθαρισμός Arrays για RAM GC
        this.deck.length = 0;
        this.discardPile.length = 0;
        this.deck = this.createDeck();
        this.discardCount = 0;
        this.resetRoundState();

        if (reset) {
            this.roundHistory.length = 0;
            this.roundStarterIndex = 0;
            this.turnIndex = 0;
            this.playerOrder.forEach(id => {
                if (this.players[id]) {
                    this.players[id].totalScore = 0;
                    this.players[id].hats = 0;
                }
            });
        } else {
            this.roundStarterIndex = (this.roundStarterIndex + 1) % this.playerOrder.length;
            this.turnIndex = this.roundStarterIndex;

            if (!this.players[this.playerOrder[this.turnIndex]]?.connected) {
                this.turnIndex = this.getNextActivePlayerIndex(this.turnIndex, 1);
            }
        }

        this.playerOrder.forEach(id => {
            if (this.players[id]) {
                if(this.players[id].hand) this.players[id].hand.length = 0;
                this.players[id].hasDrawn = false;
                this.players[id].hasAtePenalty = false;
            }
        });

        let dealCount = 0;

        this.timers.deal = setInterval(() => {
            try {
                this.playerOrder.forEach(id => {
                    if (this.deck.length > 0 && this.players[id]) {
                        this.players[id].hand.push(this.deck.pop());
                    }
                });

                if (++dealCount === STARTING_HAND_SIZE) {
                    clearInterval(this.timers.deal);
                    this.timers.deal = null;

                    let firstCard = this.deck.pop();
                    let loopProtect = 0;
                    while (firstCard && firstCard.value === 'J' && firstCard.color === 'black' && loopProtect < 15) {
                        this.deck.unshift(firstCard);
                        firstCard = this.deck.pop();
                        loopProtect++;
                    }

                    if (firstCard) {
                        this.discardPile.push(firstCard);
                        this.discardCount++;
                    }
                    
                    io.emit('gameReady');
                    this.processCardLogic(firstCard, { id: null });
                    this.resetTurnTimer();
                    this.broadcastUpdate();
                }
            } catch (e) {
                console.error("Σφάλμα κατά το μοίρασμα:", e);
                clearInterval(this.timers.deal);
            }
        }, DEAL_INTERVAL_MS);
    }

    handleRoundEnd(winnerId, closedWithAce) {
        this.clearAllTimers();
        const historyEntry = {};

        this.playerOrder.forEach(id => {
            const p = this.players[id];
            if (!p) return;

            // === ΔΙΟΡΘΩΣΗ ΓΙΑ ΤΗΝ ΠΑΥΛΑ ΣΤΟ ΣΚΟΡ ===
            const historyKey = p.sessionId || id;

            if (id === winnerId) {
                historyEntry[historyKey] = "WC";
            } else {
                let pts = this.calculateHandScore(p.hand);
                if (closedWithAce) pts += 50;
                p.totalScore += pts;
                historyEntry[historyKey] = p.totalScore;
            }
        });

        this.roundHistory.push(historyEntry);

        const under500 = this.playerOrder.filter(id => this.players[id] && this.players[id].totalScore < MAX_SCORE);
        const overOrEqual500 = this.playerOrder.filter(id => this.players[id] && this.players[id].totalScore >= MAX_SCORE);

        let finalWinnerId = null;

        if (this.playerOrder.length === 2) {
            if (overOrEqual500.length >= 1) {
                finalWinnerId = under500.length >= 1 ? under500[0] : (this.playerOrder.find(id => id !== overOrEqual500[0]) || null);
            }
        } else {
            if (under500.length === 1) {
                finalWinnerId = under500[0];
            } else if (under500.length >= 2 && overOrEqual500.length > 0) {
                const rescueScore = Math.max(...under500.map(id => this.players[id].totalScore));
                overOrEqual500.forEach(id => {
                    this.players[id].hats++;
                    this.players[id].totalScore = rescueScore;
                });
            } else if (under500.length === 0 && this.playerOrder.length > 0) {
                const lowestScore = Math.min(...this.playerOrder.map(id => this.players[id].totalScore));
                finalWinnerId = this.playerOrder.find(id => this.players[id].totalScore === lowestScore);
            }
        }

        io.emit('revealHands', this.playerOrder.map(id => this.players[id]));
        io.emit('updateScoreboard', {
            history: this.roundHistory,
            players: this.playerOrder.map(id => this.players[id]).filter(Boolean)
        });

        if (finalWinnerId) {
            const winner = this.players[finalWinnerId];
            io.emit('gameOver', `🏆 Νικητής: ${winner?.name || 'Άγνωστος'}`);
            this.gameStarted = false;
            this.refreshLobbyTimer();
            return;
        }

        this.timers.restart = setTimeout(() => {
            try {
                this.startNewRound(false);
            } catch(e) { console.error("Σφάλμα επανεκκίνησης:", e); }
        }, ROUND_RESTART_MS);
    }

    broadcastUpdate() {
        if (this.playerOrder.length === 0) return;
        
        const currentId = this.playerOrder[this.turnIndex];
        const cp = currentId ? this.players[currentId] : null;

        const publicPlayers = this.playerOrder.map(pid => {
            const p = this.players[pid];
            if (!p) return null;
            return {
                id: pid,
                sessionId: p.sessionId,
                name: p.name,
                handCount: p.hand ? p.hand.length : 0,
                hats: p.hats || 0,
                totalScore: p.totalScore || 0,
                connected: p.connected
            };
        }).filter(Boolean);

        const topCard = this.discardPile.length > 0 ? this.discardPile[this.discardPile.length - 1] : null;

        this.playerOrder.forEach(id => {
            const p = this.players[id];
            if (!p) return;

            io.to(id).emit('updateUI', {
                players: publicPlayers,
                topCard: topCard,
                discardCount: this.discardCount,
                penalty: this.penaltyStack,
                direction: this.direction,
                currentPlayerName: cp ? cp.name : "...",
                currentPlayerId: currentId,
                activeSuit: this.activeSuit,
                deckCount: this.deck.length,
                myHand: p.hand,
                isMyTurn: (id === currentId)
            });
        });
    }

    disconnectPlayer(socketId) {
        this.refreshLobbyTimer();
        if (!this.players[socketId]) return;

        this.players[socketId].connected = false;
        const activeCount = this.playerOrder.filter(id => this.players[id] && this.players[id].connected).length;

        if (!this.gameStarted) {
            this.playerOrder = this.playerOrder.filter(id => id !== socketId);
            delete this.players[socketId];
            io.emit('playerCountUpdate', this.playerOrder.length);
            return;
        }

        if (activeCount < 2) {
            this.resetToLobby();
            io.emit('gameInterrupted', { message: 'Παίκτες αποσυνδέθηκαν. Το παιχνίδι διεκόπη.' });
            io.emit('notification', 'Παίκτες αποσυνδέθηκαν. Το παιχνίδι διεκόπη.');
            this.refreshLobbyTimer();
            return;
        }

        if (this.playerOrder[this.turnIndex] === socketId) {
            this.advanceTurn(1);
            this.broadcastUpdate();
        }
    }
}

let globalGameInstance = new Game();

process.on('uncaughtException', (err) => {
    console.error('Αποτράπηκε Crash (Exception):', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('Αποτράπηκε Crash (Rejection):', reason);
});

io.on('connection', (socket) => {
    if (!globalGameInstance.gameStarted) globalGameInstance.refreshLobbyTimer();

    socket.on('joinGame', (data) => {
        if (isThrottled(socket, 'joinGame')) return;
        try { globalGameInstance.joinGame(socket, data); }
        catch (e) { console.error("Σφάλμα σύνδεσης:", e); }
    });

    socket.on('startGameRequest', () => {
        if (isThrottled(socket, 'startGameRequest')) return;
        try {
            globalGameInstance.refreshLobbyTimer();
            const activeCount = globalGameInstance.playerOrder.filter(
                id => globalGameInstance.players[id] && globalGameInstance.players[id].connected
            ).length;

            if (!globalGameInstance.gameStarted && !globalGameInstance.starting && activeCount >= 2) {
                globalGameInstance.starting = true;
                globalGameInstance.startNewRound(true);
            }
        } catch (e) { console.error("Σφάλμα εκκίνησης:", e); }
    });

    socket.on('playCard', (data) => {
        if (isThrottled(socket, 'playCard')) return;
        try { globalGameInstance.playCard(socket, data); }
        catch (e) {
            console.error("Σφάλμα κίνησης φύλλου:", e);
            socket.emit('invalidMove');
        }
    });

    socket.on('drawCard', () => {
        if (isThrottled(socket, 'drawCard')) return;
        try { globalGameInstance.drawCard(socket); }
        catch (e) { console.error("Σφάλμα τραβήγματος:", e); }
    });

    socket.on('passTurn', () => {
        if (isThrottled(socket, 'passTurn')) return;
        try { globalGameInstance.passTurn(socket); }
        catch (e) { console.error("Σφάλμα πάσο:", e); }
    });

    socket.on('chatMessage', (msg) => {
        try {
            globalGameInstance.refreshLobbyTimer();
            const p = globalGameInstance.players[socket.id];
            if (p && (!p.lastChat || Date.now() - p.lastChat > 500)) {
                p.lastChat = Date.now();
                io.emit('chatUpdate', {
                    name: p.name,
                    text: String(msg).replace(/[<>]/g, '').substring(0, MAX_CHAT_LEN)
                });
            }
        } catch (e) { console.error("Σφάλμα chat:", e); }
    });

    socket.on('disconnect', () => {
        try { globalGameInstance.disconnectPlayer(socket.id); } 
        catch (e) { console.error("Σφάλμα αποσύνδεσης:", e); }
    });
});

const PORT = process.env.PORT || 3000;

// require.main check: επιτρέπει να γίνει require() αυτού του αρχείου από
// automated tests χωρίς να ανοίγει πραγματικό network port (π.χ. unit
// tests για το Game class). Όταν τρέχει κανονικά με `node server.js`
// (π.χ. στο Render), η συμπεριφορά είναι ακριβώς ίδια όπως πριν.
if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`Ο Μαύρος Βαλές ♠️ τρέχει στο port ${PORT}`);
    });
}

module.exports = { app, server, io, Game, globalGameInstance, PORT };
