import { Router } from "express";
import { rewardsPoolService } from "../rewardsPoolService";
import { ensureAuthenticated } from "../auth"; // Assuming there is an auth middleware, need to check how they do it. I'll use passport req.user

export const rewardsPoolApiRouter = Router();

// Get the current state of the pool
rewardsPoolApiRouter.get("/current", async (req, res) => {
  try {
    const userId = req.user?.id;
    const state = await rewardsPoolService.getRewardsPoolState(userId);
    return res.json(state);
  } catch (err: any) {
    console.error("Failed to fetch rewards pool state:", err);
    return res.status(500).json({ error: "Failed to fetch rewards pool state" });
  }
});

// Claim pending rewards
rewardsPoolApiRouter.post("/claim", async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Must be logged in to claim rewards." });
    }

    const result = await rewardsPoolService.claimUserRewards(userId);
    return res.json(result);
  } catch (err: any) {
    console.error("Failed to claim rewards:", err);
    return res.status(500).json({ error: "Failed to claim rewards" });
  }
});

// Admin ONLY: Deposit surplus into the pool manually
rewardsPoolApiRouter.post("/admin/deposit", async (req, res) => {
  try {
    const user = req.user as any;
    if (!user?.isAdmin) {
      return res.status(403).json({ error: "Forbidden: Admins only" });
    }

    const { amountUsdc } = req.body;
    if (!amountUsdc || amountUsdc <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    await rewardsPoolService.addSurplusToPot(amountUsdc);
    return res.json({ success: true, amountAdded: amountUsdc });
  } catch (err: any) {
    console.error("Failed to deposit surplus:", err);
    return res.status(500).json({ error: "Failed to deposit surplus" });
  }
});

// Admin ONLY: Trigger weekly distribution manually
rewardsPoolApiRouter.post("/admin/trigger-distribution", async (req, res) => {
  try {
    const user = req.user as any;
    if (!user?.isAdmin) {
      return res.status(403).json({ error: "Forbidden: Admins only" });
    }

    const result = await rewardsPoolService.executeWeeklyDistribution();
    return res.json(result);
  } catch (err: any) {
    console.error("Failed to trigger distribution:", err);
    return res.status(500).json({ error: "Failed to trigger distribution" });
  }
});
