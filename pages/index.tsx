import { GetServerSidePropsContext } from "next";
import { getSession } from "@lib/auth";

function RedirectPage() {
  return;
}

export async function getServerSideProps(context: GetServerSidePropsContext) {
  const session = await getSession(context);
  //console.log(session);
  if (!session?.user?.id) {
    return { redirect: { permanent: false, destination: "/auth/login" } };
  }

  return { redirect: { permanent: false, destination: "/forms" } };
}

export default RedirectPage;
