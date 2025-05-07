const express = require("express");
const app = express();
const jwt = require("jsonwebtoken");
const port = process.env.PORT || 3000;
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const cookieParser = require("cookie-parser");

app.use(
  cors({
    origin: function (origin, callback) {
      const allowedOrigins = [
        "http://localhost:5173",
        "http://localhost:4173",
        "https://hotel-management-client-psi.vercel.app",
      ];
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

app.use(express.json());
app.use(cookieParser());

const uri = `mongodb+srv://${process.env.USER_NAME}:${process.env.PASSWORD}@cluster0.eykzqz7.mongodb.net/?retryWrites=true&w=majority`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const verifyToken = (req, res, next) => {
  const token = req?.cookies?.token;
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  jwt.verify(token, process.env.SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).send({ message: "unauthorized access" });
    }
    req.user = decoded;
    next();
  });
};

// Collection

const UserCollection = client.db("HotelManagement").collection("Users");
const ReviewCollection = client.db("HotelManagement").collection("Reviews");
const RoomsCollection = client.db("HotelManagement").collection("Rooms");
const BookedCollection = client.db("HotelManagement").collection("Booked");
const GalleryCollection = client.db("HotelManagement").collection("Gallery");
const CancelCollection = client
  .db("HotelManagement")
  .collection("CancelBooking");

async function run() {
  try {
    // User CRUD Operation
    app.post("/user", async (req, res) => {
      const data = req.body;
      const user = await UserCollection.findOne({ email: data.email });
      if (!user) {
        const result = await UserCollection.insertOne(data);
        res.send(result);
      } else {
        res.send("User already Exist");
      }
    });

    app.get("/users", async (req, res) => {
      try {
        const customers = await UserCollection.find({
          role: "Customer",
        }).toArray();
        res.send(customers);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch users", error });
      }
    });

    app.get("/officials", async (req, res) => {
      try {
        const officials = await UserCollection.find({
          role: { $in: ["Admin", "Staff"] },
        }).toArray();
        res.send(officials);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch officials", error });
      }
    });

    app.get("/user/:email", async (req, res) => {
      const userEmail = req.params.email;
      const result = await UserCollection.findOne({ email: userEmail });
      res.send(result);
    });

    app.put("/user/:email", async (req, res) => {
      const email = req.params.email;
      const data = req.body;
      const result = await UserCollection.updateOne(
        { email },
        { $set: data },
        { upsert: false }
      );
      res.send(result);
    });

    app.delete("/user/:id", async (req, res) => {
      const id = req.params.id;
      const result = await UserCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });
    // CRUD of user end Here

    app.get("/myBookings", verifyToken, async (req, res) => {
      if (req.user.email !== req.query.email) {
        return res.status(401).send({ message: "Forbidden Access" });
      }

      const userEmail = req.query.email;
      const query = { userEmail: userEmail };

      const result = await BookedCollection.find(query)
        .sort({ _id: -1 })
        .toArray();

      res.send(result);
    });

    // Make a Resurvation
    app.post("/reservation", async (req, res) => {
      try {
        const data = req.body;
        const reservationData = data?.reservationData;
        const roomData = data?.roomData;
        const userData = data?.userData;

        // 1. Update room's unavailable dates in RoomsCollection
        const query = { _id: new ObjectId(roomData?._id) };
        const update = {
          $set: {
            unAvailable: roomData?.unAvailable || [],
          },
        };
        const updateRoomData = await RoomsCollection.updateOne(query, update);

        // 2. Insert reservation into BookedCollection
        const result = await BookedCollection.insertOne(reservationData);

        // 3. Update Room Data
        const userQuery = { _id: new ObjectId(userData?._id) };

        // Ensure BookingID is always treated as an array
        const existingBookingIDs = userData?.BookingID || [];

        const newUserData = [...existingBookingIDs, result.insertedId];

        const userUpdate = {
          $set: { BookingID: newUserData },
        };

        const updateRoom = await UserCollection.updateOne(
          userQuery,
          userUpdate
        );

        res.send(result);
      } catch (error) {
        console.error("Reservation error:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.delete("/deleteBookings/:id", async (req, res) => {
      try {
        const bookingId = req.params.id;
        const query = { _id: new ObjectId(bookingId) };

        // 1. Get the reservation
        const reservation = await BookedCollection.findOne(query);
        if (!reservation) {
          return res.status(404).send({ message: "Reservation not found" });
        }

        const { roomId, userId, checkIn, checkOut } = reservation;

        // 2. Add to CancelCollection
        const cancelData = {
          ...reservation,
          refund: false,
          cancelledAt: new Date(),
        };
        await CancelCollection.insertOne(cancelData);

        // 3. Delete reservation from BookedCollection
        await BookedCollection.deleteOne(query);

        // 4. Remove booking ID from UserCollection
        await UserCollection.updateOne(
          { _id: new ObjectId(userId) },
          { $pull: { BookingID: new ObjectId(bookingId) } }
        );

        // 5. Prepare exact date objects for pull
        const startDate = new Date(checkIn);
        const endDate = new Date(checkOut);
        const days = [];

        for (
          let d = new Date(startDate);
          d < endDate;
          d.setDate(d.getDate() + 1)
        ) {
          // Set time to 18:00 UTC to match your DB
          const correctDate = new Date(
            Date.UTC(
              d.getUTCFullYear(),
              d.getUTCMonth(),
              d.getUTCDate(),
              18,
              0,
              0
            )
          );
          days.push(correctDate);
        }

        console.log("Trying to remove these unAvailable dates:", days);

        // 6. Pull those dates from room
        const updateResult = await RoomsCollection.updateOne(
          { _id: new ObjectId(roomId) },
          {
            $pull: {
              unAvailable: {
                $in: days.map((date) => date.toISOString()),
              },
            },
          }
        );

        console.log("Room update result:", updateResult);

        res.send({
          success: true,
          message: "Reservation fully cancelled and unAvailable dates removed.",
          removedDates: days,
        });
      } catch (error) {
        console.error("Delete reservation error:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // Get all bookings with pagination
    app.get("/api/bookings", async (req, res) => {
      try {
        // Parse pagination parameters
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const totalCount = await BookedCollection.countDocuments();

        // Get paginated bookings
        const bookings = await BookedCollection.find()
          .sort({ reservationTime: -1 }) // Sort by newest first
          .skip(skip)
          .limit(limit)
          .toArray();

        res.json({
          success: true,
          bookings,
          totalCount,
          currentPage: page,
          totalPages: Math.ceil(totalCount / limit),
        });
      } catch (error) {
        console.error("Error fetching bookings:", error);
        res.status(500).json({
          success: false,
          message: "Internal server error",
        });
      }
    });

    app.put("/UpdateBooking/:id", async (req, res) => {
      const id = req.params.id;
      const data = req.body.startDate;
      const query = { _id: new ObjectId(id) };
      const option = { upsert: false };
      const setData = {
        $set: {
          bookedDate: data,
        },
      };
      const result = await BookedCollection.updateOne(query, setData, option);
      res.send(result);
    });

    // Handle Review
    app.post("/postReview", async (req, res) => {
      const body = req.body;
      const result = await ReviewCollection.insertOne(body);
      res.send(result);
    });

    app.get("/status", async (req, res) => {
      try {
        // Get today's date in the same format as stored in DB
        const today = new Date();
        const todayString = `${
          today.getMonth() + 1
        }/${today.getDate()}/${today.getFullYear()}`;

        // Query using the string format
        const todaysCheckins = await BookedCollection.find({
          checkIn: todayString,
        }).toArray();

        const todayCheckOuts = await BookedCollection.find({
          checkOut: todayString,
        }).toArray();

        const cancelledBookings = await CancelCollection.find({
          refund: false,
        }).toArray();

        res.send({
          success: true,
          todaysCheckins: todaysCheckins,
          todayCheckOuts: todayCheckOuts,
          cancelledBookings: cancelledBookings,
        });
      } catch (error) {
        console.error("Error fetching today's check-ins:", error);
        res.status(500).json({
          success: false,
          message: "Server error while fetching check-ins",
        });
      }
    });

    // PATCH endpoint to update check-in status
    app.patch("/isCheck/reservations/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { isCheckIn } = req.body;

        // Validate the ID
        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid reservation ID" });
        }

        // Update the reservation
        const result = await BookedCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { isCheckIn: isCheckIn } }
        );

        // Check if document was found and updated
        if (result.matchedCount === 0) {
          return res
            .status(404)
            .json({ success: false, message: "Reservation not found" });
        }

        res.json({
          success: true,
          message: "Check-in status updated successfully",
          updated: result.modifiedCount,
        });
      } catch (error) {
        console.error("Error updating check-in status:", error);
        res.status(500).json({
          success: false,
          message: "Server error while updating check-in status",
          error: error.message,
        });
      }
    });

    // PATCH endpoint for updating check-out status
    app.patch("/checkout/reservations/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { isCheckOut } = req.body;

        // Validate MongoDB ID
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid reservation ID format",
          });
        }

        // Update the document
        const result = await BookedCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { isCheckOut: isCheckOut !== undefined ? isCheckOut : true } }
        );

        // Handle cases where document wasn't found
        if (result.matchedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Reservation not found",
          });
        }

        // Successful response
        res.json({
          success: true,
          message: `Check-out status updated to ${
            isCheckOut !== undefined ? isCheckOut : true
          }`,
          updatedFields: {
            isCheckOut: isCheckOut !== undefined ? isCheckOut : true,
          },
        });
      } catch (error) {
        console.error("Check-out update error:", error);
        res.status(500).json({
          success: false,
          message: "Internal server error while updating check-out status",
          error: error.message,
        });
      }
    });

    // PATCH endpoint for updating refund status
    app.patch("/api/cancellations/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { refund } = req.body;

        // 1. Validate the cancellation ID
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid cancellation ID format",
          });
        }

        // 2. Find the cancellation record
        const cancellation = await CancelCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!cancellation) {
          return res.status(404).json({
            success: false,
            message: "Cancellation record not found",
          });
        }

        // 3. Prepare update data
        const updateData = {
          refund: refund !== undefined ? refund : !cancellation.refund,
          refundProcessedAt: refund ? new Date() : null,
        };

        // 4. Update the cancellation record
        const result = await CancelCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );

        // 5. Verify the update was successful
        if (result.matchedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "No cancellation record was updated",
          });
        }

        // 6. Return success response
        res.json({
          success: true,
          message: `Refund status ${
            updateData.refund ? "approved" : "reversed"
          }`,
          cancellationId: id,
          changes: {
            refund: updateData.refund,
            refundProcessedAt: updateData.refundProcessedAt,
          },
        });
      } catch (error) {
        console.error("Refund status update error:", error);
        res.status(500).json({
          success: false,
          message: "Internal server error while updating refund status",
          error: error.message,
        });
      }
    });

    app.get("/reviews", async (req, res) => {
      const result = await ReviewCollection.find().toArray();
      res.send(result);
    });

    app.get("/perReviews/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { roomID: id };
        const result = await ReviewCollection.find(query).toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching reviews:", error);
        res.status(500).send({ error: "Failed to fetch reviews" });
      }
    });

    app.post("/jwt", async (req, res) => {
      try {
        const user = req.body;

        // Generate the JWT token with a 7-day expiration
        const token = jwt.sign(user, process.env.SECRET, { expiresIn: "7d" });

        // Set the token in the cookie
        res
          .cookie("token", token, {
            httpOnly: true, // Prevent access via JavaScript
            secure: true, // Only set cookie on HTTPS (set false in dev)
            sameSite: "none", // Allows cross-site cookies
            maxAge: 7 * 24 * 60 * 60 * 1000, // Max Age set to 7 days in milliseconds
          })
          .send({ success: true }); // Ensure only basic data is sent back
      } catch (error) {
        console.error("Error creating JWT:", error);
        res.status(500).send({ error: "Failed to generate token" });
      }
    });

    // Add Room
    app.post("/room", async (req, res) => {
      const data = req.body;
      const result = await RoomsCollection.insertOne(data);
      res.send(result);
    });

    // Gets room
    app.get("/rooms", async (req, res) => {
      const sort = {};
      if (req.query.order == "asec") {
        sort.pricePerNight = 1;
      } else if (req.query.order == "desc") {
        sort.pricePerNight = -1;
      }

      const result = await RoomsCollection.find().sort(sort).toArray();
      res.send(result);
    });

    // Get Single Room
    app.get("/rooms/:Id", async (req, res) => {
      const Id = req.params.Id;

      try {
        const query = { _id: new ObjectId(Id) };
        const result = await RoomsCollection.findOne(query);
        res.send(result);
      } catch (error) {
        console.error("Error fetching room:", error);
        res.status(500).send({ error: "Something went wrong" });
      }
    });

    app.get("/getBookingByEmailId", async (req, res) => {
      const email = req.query.email;
      const RoomId = req.query.roomId;
      const query = { email: email, roomId: RoomId };
      const result = await BookedCollection.find(query).toArray();
      res.send(result);
    });

    app.get("/RoomSeat/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await SeatCollection.findOne(query);
      res.send(result);
    });

    app.post("/logout", async (req, res) => {
      const user = req.body;
      res.clearCookie("token", { maxAge: 0 }).send({ success: true });
    });

    // Send a ping to confirm a successful connection
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
