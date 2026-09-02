import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();
const adminDist = path.resolve(__dirname, "../../refer-reward-admin/dist/public");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);
app.use("/admin", express.static(adminDist));
app.use("/admin", (req, res, next) => {
  if (req.method === "GET" && req.accepts("html")) {
    res.sendFile(path.join(adminDist, "index.html"));
    return;
  }
  next();
});

export default app;
