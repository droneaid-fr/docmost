import { Section, Text } from '../components';
import * as React from 'react';
import { content, paragraph } from '../css/styles';
import { EmailButton, MailBody } from '../partials/partials';
import { APP_NAME } from '../../../droneaid/branding/brand'; // DroneAid

interface Props {
  inviteLink: string;
  expiresInDays: number;
}

export const InvitationEmail = ({ inviteLink, expiresInDays }: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Text style={paragraph}>Hi there,</Text>
        <Text style={paragraph}>You have been invited to {APP_NAME}.</Text>
        <Text style={paragraph}>
          Please click the button below to accept this invitation.
        </Text>
        <Text style={paragraph}>
          This link is valid for {expiresInDays} days.
        </Text>
      </Section>
      <EmailButton href={inviteLink}>Accept Invite</EmailButton>
    </MailBody>
  );
};

export default InvitationEmail;
