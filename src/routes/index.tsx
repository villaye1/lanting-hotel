import { createFileRoute } from "@tanstack/react-router";
import { HotelGame } from "@/components/hotel-game";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <HotelGame />;
}
