import { Client } from "@/client";
import { ClientAuthRequest, Token } from "@/models/gateway-payloads";
import { RateLimit } from "@/utils/rate-limit";
import { commandManager } from "@/commands/command-manager";
import SocketIO from "socket.io";
import SnowyFlake from "snowyflake";
import { validateEmbed } from "@/utils/embed-validator";
import { escapeHtml, normalizeName, validate } from "@/utils/string-validator";
import { User } from "@/db";
import { ImageService } from "@/image";
import { container, inject, singleton } from "tsyringe";
import { logger } from "@/logger";
import { TokenService } from "@/token-service";
import { EmbedPayload } from "@/models/embed";
import { selectMany } from "@/utils/map";

@singleton()
export class ClientManager {
    private messageRateLimit = new RateLimit(5, 5000);
    private clients: Map<string, Client>;
    private sockets: Map<string, Client>;

    constructor(
      @inject("io") private readonly io: SocketIO.Server,
      @inject("options") private readonly options: any,
      private readonly tokenService: TokenService,
      private readonly snowFlake: SnowyFlake,
      private readonly imageService: ImageService
    ) {
        this.clients = new Map();
        this.sockets = new Map();
    }

    async start() {
        logger.info("starting server")

        this.io.on("connection", (socket) => this.onClientConnected(socket));
    }

    updateUser(user: Client) {
        this.io.emit("user-edit", user.serialize());
    }

    get(id: string) {
        return this.clients.get(id);
    }

    private onClientConnected(socket: SocketIO.Socket) {
        logger.info("client", socket.id, " connected");

        socket.on("disconnect", () => this.onClientDisconnect(socket));
        socket.on("login", (options) => this.onClientAuthenticated(socket, options));

        socket.emit("sys-commands", commandManager.commands);
    }

    private async onClientAuthenticated(socket: SocketIO.Socket, request: ClientAuthRequest) {
        if (this.sockets.has(socket.id)) {
            this.onClientDisconnect(socket);
        }

        let token: Token = null;

        if (request.token) {
            try {
                token = this.tokenService.decode(request.token);
            } catch {
                // ignore
            }
        }

        const id = token?.id ?? this.snowFlake.nextId().toString();

        let client = this.clients.get(id);
        let isNew = false;

        if (!client) {
            let user = await User.findOne({ id });

            if (!user) {
                user = new User();
                user.id = id;
                user.name = "anon-" + socket.id.substr(0, 6);
                user.avatar = await this.imageService.getRandomImage();
            }

            if (request.name) {
                try {
                    user.name = normalizeName(request.name);
                } catch {
                    // ignore
                }
            }

            user.lastLogin = new Date();
            user.bot = !!request.bot;

            await user.save();

            client = container.resolve(Client);
            client.user = user;
            isNew = true;

            this.clients.set(id, client);
        }

        client.registerSocket(socket);
        this.sockets.set(socket.id, client);

        socket.emit("ready", {
            user: client.serialize(),
            members: Array.from(this.clients.values()).map(x => x.serialize()),
            token: this.tokenService.createToken(client.id),
        });

        socket.on("usr-typ", () => this.onClientStartTyping(socket));
        socket.on("usr-msg", (msg) => this.onClientMessageReceived(socket, msg));

        if (isNew) {
            this.io.emit("sys-join", client.serialize());
        }
    }

    private onClientDisconnect(socket: SocketIO.Socket) {
        logger.info("user", socket.id, " disconnected");
        const client = this.sockets.get(socket.id);
        this.sockets.delete(socket.id);

        if (client && client.unregisterSocket(socket)) {
            this.clients.delete(client.id);
            this.io.emit("sys-leave", client.serialize());
        }
    }

    private onClientStartTyping(socket: SocketIO.Socket) {
        const client = this.sockets.get(socket.id);

        this.io.emit("usr-typ", {
            id: client.id,
            name: client.name,
        });
    }

    private async onClientMessageReceived(socket: SocketIO.Socket, msg: any) {
        const client = this.sockets.get(socket.id);

        if (commandManager.handle(this, client, msg.message)) {
            return;
        }

        if (!this.messageRateLimit.check(socket.id)) {
            return;
        }

        if ((msg.message || "").length > 256) {
            msg.message = msg.message.substr(0, 256);
        }

        this.sendMessage(client.id, msg.message);
    }

    sendMessage(userId: string, content: string, embed?: EmbedPayload) {
        this.io.emit('usr-msg', {
            id: this.snowFlake.nextId().toString(),
            user: userId,
            content: escapeHtml(content),
            embed: validateEmbed(embed),
            mentions: this.getMentions(content)
        });
    }

    getMentions(content: string): string[] {
        if (!content) {
            return [];
        }

        return selectMany(
          content
            .split(" ")
            .filter(word => word.startsWith("@"))
            .map(mention => mention.substr(1)),
          nick => [...this.clients.values()]
            .filter(c => c.name === nick)
            .map(c => c.id)
        );
    }
}